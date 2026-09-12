'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness, deferred } = require('./helpers/renderer-harness');
const line = (speechToken) => ({ speechToken, file: 'generated/test.wav', expression: 'worried', translation: '测试' });
const count = (h, name) => h.calls.filter(call => call.name === name).length;

test('cancel while audio device is resuming cannot resurrect an old line', async () => {
  const resume = deferred();
  const h = createRendererHarness({ resume: () => resume.promise });
  const pending = h.callbacks.onSpeak(line(1));
  h.callbacks.onSpeechCancelled({token: 1, reason: 'start-timeout'});
  resume.resolve(); await pending;
  assert.equal(h.audios.length, 0);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(count(h, 'speechStarted'), 0);
  assert.equal(count(h, 'speechEnded'), 1);
  assert.equal(h.run('isSpeaking'), false);
});

test('late play completion, ended and cancellation cannot touch the next line', async () => {
  const play = deferred();
  let first = true;
  const h = createRendererHarness({ play: () => { if (first) { first = false; return play.promise; } return Promise.resolve(); } });
  const pending = h.callbacks.onSpeak(line(1));
  await new Promise(setImmediate);
  assert.equal(h.audios.length, 1);
  h.callbacks.onSpeechCancelled({token: 1, reason: 'timeout'});
  await h.callbacks.onSpeak(line(2));
  play.resolve(); await pending;
  h.audios[0].emit('ended');
  h.audios[0].emit('error');
  h.callbacks.onSpeechCancelled({token: 1});
  assert.equal(h.run('speechToken'), 2);
  assert.equal(h.audios[0].paused, true);
  assert.equal(h.audios[1].paused, false);
  assert.equal(count(h, 'speechStarted'), 1);
  h.audios[1].emit('ended');
  h.audios[1].emit('error');
  assert.equal(count(h, 'speechEnded'), 2);
  assert.equal(h.run('isSpeaking'), false);
});

test('failed play releases the slot; duplicate and old commands are ignored', async () => {
  const h = createRendererHarness({ play: () => Promise.reject(new Error('device unavailable')) });
  await h.callbacks.onSpeak(line(9));
  await h.callbacks.onSpeak(line(9));
  await h.callbacks.onSpeak(line(8));
  await h.callbacks.onSpeak({...line(10), speechToken: 0});
  assert.equal(h.audios.length, 1);
  assert.equal(h.audios[0].paused, true);
  assert.equal(count(h, 'speechEnded'), 1);
  assert.equal(count(h, 'speechStarted'), 0);
  assert.equal(h.run('speechMouthLevel'), 0);
});
