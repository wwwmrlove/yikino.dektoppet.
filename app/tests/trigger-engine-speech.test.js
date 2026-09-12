'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTriggerEngine } = require('../trigger-engine');
const { harness, sentToken } = require('./helpers/trigger-engine-harness');

test('only the exact positive main-process token can start or release a speech slot', (t) => {
  const { engine, events } = harness(t);
  engine.playManual({ id: 'first' });
  const first = sentToken(events);
  assert.ok(Number.isSafeInteger(first) && first > 0);
  engine.playManual({ id: 'second' });
  for (const invalid of [0, undefined, null, -1, first + 1, String(first), NaN]) {
    assert.equal(engine.onSpeechStarted({ token: invalid, durationMs: 5000 }), false);
    assert.equal(engine.onSpeechEnded(invalid), false);
  }
  assert.equal(events.length, 1);
  assert.equal(engine.onSpeechStarted({ token: first, durationMs: 5000 }), true);
  assert.equal(engine.onSpeechEnded(first), true);
  const second = sentToken(events, 1);
  assert.ok(second > first);
  assert.equal(engine.onSpeechEnded(first), false);
  assert.equal(engine.onSpeechStarted({ token: first, durationMs: 5000 }), false);
  assert.equal(engine.getDebugState().activeSpeechToken, second);
  assert.equal(engine.onSpeechEnded(second), true); // Loading errors may end before started.
  assert.equal(engine.getDebugState().speechActive, false);
});

test('missing started notification cancels before dispatching the next queued line', (t) => {
  const { engine, events } = harness(t);
  engine.playManual({ id: 'stuck-loading' });
  engine.playManual({ id: 'next' });
  const token = sentToken(events);
  t.mock.timers.tick(9999);
  assert.equal(events.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(events.map((event) => event.type), ['send', 'cancel', 'send']);
  assert.deepEqual(events[1], { type: 'cancel', token, reason: 'speech-start-timeout' });
  assert.equal(events[2].dialogue.id, 'next');
  assert.equal(engine.onSpeechEnded(token), false);
  assert.equal(engine.getDebugState().activeSpeechToken, sentToken(events, 1));
});

test('started speech gets its duration plus buffer; duplicate starts cannot extend the watchdog', (t) => {
  const { engine, events } = harness(t);
  engine.playManual({ id: 'stuck-playing' });
  engine.playManual({ id: 'next' });
  const token = sentToken(events);
  assert.equal(engine.onSpeechStarted({ token, durationMs: 23000 }), true);
  t.mock.timers.tick(20000);
  assert.equal(engine.onSpeechStarted({ token, durationMs: 200000 }), false);
  t.mock.timers.tick(7999);
  assert.equal(events.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(events.map((event) => event.type), ['send', 'cancel', 'send']);
  assert.equal(events[1].reason, 'speech-end-timeout');
});

test('unbounded audio duration is capped at three minutes', (t) => {
  const { engine, events } = harness(t);
  engine.playManual({ id: 'bad-duration' });
  engine.onSpeechStarted({ token: sentToken(events), durationMs: 1e12 });
  t.mock.timers.tick(179999);
  assert.equal(events.length, 1);
  t.mock.timers.tick(1);
  assert.equal(events[1].type, 'cancel');
  assert.equal(engine.getDebugState().speechActive, false);
});

test('missing audio duration still times out and a normal end cancels its watchdog', (t) => {
  const { engine, events } = harness(t);
  engine.playManual({ id: 'missing-duration' });
  engine.onSpeechStarted({ token: sentToken(events), durationMs: NaN });
  t.mock.timers.tick(59999);
  assert.equal(events.length, 1);
  t.mock.timers.tick(1);
  assert.equal(events[1].type, 'cancel');
  engine.playManual({ id: 'healthy' });
  const token = sentToken(events, 1);
  engine.onSpeechStarted({ token, durationMs: 4000 });
  engine.onSpeechEnded(token);
  t.mock.timers.tick(180000);
  assert.equal(events.filter((event) => event.type === 'cancel').length, 1);
});

test('renderer recovery drops stale work, blocks dispatch and never reuses the old token', (t) => {
  const { engine, events } = harness(t, { rendererReady: false });
  assert.equal(engine.playManual({ id: 'before-ready' }), false);
  engine.onRendererReady();
  engine.playManual({ id: 'before-crash' });
  const oldToken = sentToken(events);
  engine.playManual({ id: 'stale-queue' });
  engine.onRendererUnavailable();
  assert.equal(engine.getDebugState().speechActive, false);
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  assert.equal(engine.playManual({ id: 'during-recovery' }), false);
  t.mock.timers.tick(180000);
  assert.equal(events.length, 1);
  engine.onRendererReady();
  assert.equal(events.length, 1);
  engine.playManual({ id: 'after-recovery' });
  assert.ok(sentToken(events, 1) > oldToken);
  assert.equal(engine.onSpeechEnded(oldToken), false);
  assert.equal(engine.getDebugState().speechActive, true);
});

test('failed cancellation blocks replacement speech until explicit renderer recovery', (t) => {
  const { engine, events, errors } = harness(t, { cancelSpeech: () => { throw new Error('destroyed webContents'); } });
  engine.playManual({ id: 'stuck' });
  engine.playManual({ id: 'must-not-overlap' });
  t.mock.timers.tick(10000);
  assert.equal(events.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(engine.getDebugState().rendererReady, false);
  assert.equal(engine.getDebugState().speechActive, false);
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  engine.onRendererReady();
  engine.playManual({ id: 'recovered' });
  assert.equal(events.length, 2);
});

test('failed speech delivery releases its reservation and does not record a successful dispatch', (t) => {
  const { engine, events, errors, files } = harness(t, { sendSpeech: () => false });
  engine.playManual({ id: 'undeliverable' });
  assert.equal(engine.getDebugState().speechActive, false);
  assert.equal(engine.getDebugState().rendererReady, false);
  assert.equal(engine.getDebugState().lastSpeechAt, 0);
  assert.equal(files.size, 0);
  t.mock.timers.tick(180000);
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1);
});

test('stop clears startup, resume, periodic and speech timers, plus pending queue', (t) => {
  const { engine, events, powerMonitor } = harness(t);
  engine.start();
  powerMonitor.emit('resume');
  powerMonitor.emit('unlock-screen');
  engine.playManual({ id: 'active' });
  engine.playManual({ id: 'queued' });
  engine.stop();
  assert.equal(powerMonitor.listenerCount('resume'), 0);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  assert.equal(engine.getDebugState().speechActive, false);
  assert.equal(engine.onRendererReady(), false);
  assert.equal(engine.playManual({ id: 'after-stop' }), false);
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(events.length, 1);
});

test('recreating an engine in the same main process does not reuse speech tokens', (t) => {
  const { engine, events, options } = harness(t);
  engine.playManual({ id: 'first-engine' });
  const oldToken = sentToken(events);
  engine.stop();
  const replacement = createTriggerEngine(options);
  t.after(() => replacement.stop());
  replacement.playManual({ id: 'second-engine' });
  assert.ok(sentToken(events, 1) > oldToken);
  assert.equal(replacement.onSpeechStarted({ token: oldToken }), false);
  assert.equal(replacement.onSpeechEnded(oldToken), false);
  assert.equal(replacement.getDebugState().speechActive, true);
});
