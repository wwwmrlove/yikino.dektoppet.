'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, sentToken } = require('./helpers/trigger-engine-harness');

function line(trigger, priority = 50) {
  return { id: trigger, triggers: [trigger], autoEnabled: true, priority, cooldownMinutes: 0, translation: `${trigger} 原始台词。` };
}

function weather(patch = {}) {
  return {
    locationId: 'beijing-chaoyang', city: '北京市朝阳区', state: 'thunder', label: '雷雨',
    fetchedAt: Date.now(), temperature: 22, apparentTemperature: 23, hot: false, cold: false, windy: false,
    severe: true, signature: 'thunder:22', ...patch
  };
}

const weatherLines = [
  line('weather_thunder', 85), line('weather_heavy_rain', 80), line('weather_snow', 65),
  line('weather_hot', 60), line('weather_cold', 60), line('weather_windy', 55), line('weather_rain', 55),
  line('weather_clear', 25), line('weather_cloudy', 25)
];
const clickLines = [line('click_single'), line('click_double', 60), line('click_rapid', 90)];

test('disabling the weather service clears both automatic and manually queued weather', (t) => {
  let context;
  const { engine, events } = harness(t, { dialogues: weatherLines, getWeatherContext: () => context });
  context = weather();
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('weather_thunder');
  engine.announceWeather();
  assert.equal(engine.getDebugState().eventQueue.length, 2);
  const previous = context;
  context = null;
  engine.handleWeatherUpdate(null, previous, { reason: 'disabled' });
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events.length, 1);
});

test('switching location invalidates queued weather immediately, including explicit weather requests', (t) => {
  let context;
  const { engine, events } = harness(t, { dialogues: weatherLines, getWeatherContext: () => context });
  context = weather();
  engine.playManual({ id: 'busy' });
  engine.announceWeather();
  const previous = context;
  context = weather({ locationId: 'shanghai-huangpu', city: '上海市黄浦区' });
  engine.handleWeatherUpdate(context, previous, { reason: 'location-changed' });
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events.length, 1);
});

test('dispatch rechecks location, stale cache, and current condition even if the update callback was lost', async (t) => {
  for (const changed of [
    () => null,
    () => weather({ locationId: 'another-city' }),
    () => weather({ fetchedAt: Date.now() - 6 * 60 * 60 * 1000 - 1 }),
    () => weather({ state: 'clear', label: '晴朗', severe: false, signature: 'clear:22' })
  ]) {
    await t.test('invalid pending weather is removed at release', (subtest) => {
      let context;
      const { engine, events } = harness(subtest, { dialogues: weatherLines, getWeatherContext: () => context });
      context = weather();
      engine.playManual({ id: 'busy' });
      engine.announceWeather();
      context = changed();
      engine.onSpeechEnded(sentToken(events));
      assert.equal(events.length, 1);
      assert.equal(engine.getDebugState().eventQueue.length, 0);
    });
  }
});

test('weather subtitle is reconstructed once from the latest same-city cache and the original line', (t) => {
  let context;
  const { engine, events } = harness(t, { dialogues: weatherLines, getWeatherContext: () => context });
  context = weather();
  engine.playManual({ id: 'busy' });
  engine.announceWeather();
  context = weather({ temperature: 24, apparentTemperature: 25, stale: true });
  engine.onSpeechEnded(sentToken(events));
  const subtitle = events[1].dialogue.translation;
  assert.ok(subtitle.includes('24℃'));
  assert.ok(subtitle.includes('体感25℃'));
  assert.ok(!subtitle.includes('22℃'));
  assert.equal(subtitle.split('北京市朝阳区').length - 1, 1);
  assert.ok(subtitle.endsWith('weather_thunder 原始台词。'));
});

test('offline same-location cache within six hours remains usable without creating a new failed-refresh reminder', (t) => {
  let context;
  const { engine, events } = harness(t, { dialogues: weatherLines, getWeatherContext: () => context });
  context = weather({ stale: true, fetchedAt: Date.now() - 2 * 60 * 60 * 1000 });
  engine.playManual({ id: 'busy' });
  engine.announceWeather();
  engine.handleWeatherUpdate(context, context, { reason: 'refresh-failed' });
  assert.equal(engine.getDebugState().eventQueue.length, 1);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events[1].dialogue.triggerName, 'weather_thunder');
});

test('quiet-time weather at the front cannot block a lower-priority click', (t) => {
  let context;
  let quiet = false;
  const { engine, events } = harness(t, {
    dialogues: [...weatherLines, ...clickLines],
    getWeatherContext: () => context,
    getBehaviorSettings: () => ({ quietStart: quiet ? '00:00' : '01:00', quietEnd: quiet ? '23:59' : '06:30' })
  });
  context = weather();
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('weather_thunder');
  quiet = true;
  engine.requestTrigger('click_single');
  assert.equal(engine.getDebugState().eventQueue[0].triggerName, 'weather_thunder');
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events[1].dialogue.triggerName, 'click_single');
  assert.equal(engine.getDebugState().autoCount, 0);
  assert.equal(engine.getDebugState().eventQueue[0].triggerName, 'weather_thunder');
});

test('turning proactive behavior off clears its pending events and preserves the click response', (t) => {
  let proactiveEnabled = true;
  const { engine, events } = harness(t, {
    dialogues: [line('return_after_idle', 80), ...clickLines],
    getBehaviorSettings: () => ({ proactiveEnabled, quietStart: '00:00', quietEnd: '00:00' })
  });
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('return_after_idle');
  engine.requestTrigger('click_single');
  proactiveEnabled = false;
  engine.onSettingsChanged();
  assert.equal(engine.getDebugState().eventQueue.length, 1);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events[1].dialogue.triggerName, 'click_single');
});

test('severe-only weather mode selects heat during ordinary rain and merges simultaneous wind in one subtitle', (t) => {
  let context;
  const { engine, events } = harness(t, {
    dialogues: weatherLines, getWeatherContext: () => context,
    getBehaviorSettings: () => ({ weatherMode: 'severe', quietStart: '00:00', quietEnd: '00:00' })
  });
  context = weather({ state: 'clear', severe: false, signature: 'clear:22' });
  engine.handleWeatherUpdate(context, null, { reason: 'refreshed' });
  const previous = context;
  context = weather({ state: 'rain', label: '有雨', hot: true, windy: true, severe: false, temperature: 34, apparentTemperature: 36, signature: 'rain:hot:windy' });
  assert.equal(engine.handleWeatherUpdate(context, previous, { reason: 'refreshed' }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].dialogue.triggerName, 'weather_hot');
  assert.match(events[0].dialogue.translation, /有雨.*34℃.*高温、大风/);
});

test('clear-to-windy is an important change and thunder still outranks simultaneous heat and wind', (t) => {
  let context;
  const { engine, events } = harness(t, { dialogues: weatherLines, getWeatherContext: () => context });
  context = weather({ state: 'clear', severe: false, signature: 'clear:22' });
  engine.handleWeatherUpdate(context, null, { reason: 'refreshed' });
  const previous = context;
  context = weather({ state: 'clear', label: '晴朗', windy: true, severe: false, signature: 'clear:windy' });
  assert.equal(engine.handleWeatherUpdate(context, previous, { reason: 'refreshed' }), true);
  assert.equal(events[0].dialogue.triggerName, 'weather_windy');
  engine.onSpeechEnded(sentToken(events));
  context = weather({ hot: true, windy: true });
  engine.announceWeather();
  assert.equal(events[1].dialogue.triggerName, 'weather_thunder');
});

test('a click is not blocked by the proactive cooldown and does not consume proactive time or quota', (t) => {
  const { engine, events } = harness(t, { dialogues: [line('time_noon'), ...clickLines] });
  engine.requestTrigger('time_noon');
  engine.onSpeechEnded(sentToken(events));
  const before = engine.getDebugState();
  t.mock.timers.tick(1000);
  assert.equal(engine.requestTrigger('click_single'), true);
  assert.equal(events[1].dialogue.triggerName, 'click_single');
  assert.equal(engine.getDebugState().lastSpeechAt, before.lastSpeechAt);
  assert.equal(engine.getDebugState().autoCount, before.autoCount);
  assert.equal(engine.getDebugState().lastInteractionAt, Date.now());
});

test('clicks use an eight-second cross-type cooldown and retain their 45/30/20-second event limits', (t) => {
  const { engine, events } = harness(t, { dialogues: clickLines });
  assert.equal(engine.requestTrigger('click_single'), true);
  engine.onSpeechEnded(sentToken(events));
  t.mock.timers.tick(7999);
  assert.equal(engine.requestTrigger('click_double'), false);
  t.mock.timers.tick(1);
  assert.equal(engine.requestTrigger('click_double'), true);
  engine.onSpeechEnded(sentToken(events, 1));
  t.mock.timers.tick(8000);
  assert.equal(engine.requestTrigger('click_single'), false);
  assert.equal(engine.requestTrigger('click_rapid'), true);
  engine.onSpeechEnded(sentToken(events, 2));
  t.mock.timers.tick(19000);
  assert.equal(engine.requestTrigger('click_rapid'), false);
  t.mock.timers.tick(1000);
  assert.equal(engine.requestTrigger('click_rapid'), true);
  engine.onSpeechEnded(sentToken(events, 3));
  t.mock.timers.tick(9000);
  assert.equal(engine.requestTrigger('click_single'), true);
  assert.equal(engine.getDebugState().autoCount, 0);
  assert.equal(engine.getDebugState().lastSpeechAt, 0);
});

test('busy speech is not interrupted and a queued click can respond within five seconds', (t) => {
  const { engine, events } = harness(t, { dialogues: clickLines });
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('click_rapid');
  assert.equal(events.length, 1);
  t.mock.timers.tick(4999);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events[1].dialogue.triggerName, 'click_rapid');
});

test('a click delayed for five seconds is dropped instead of producing a late complaint', (t) => {
  const { engine, events } = harness(t, { dialogues: clickLines });
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('click_rapid');
  t.mock.timers.tick(5000);
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events.length, 1);
  assert.equal(engine.getDebugState().eventQueue.length, 0);
  assert.equal(engine.getDebugState().lastInteractionAt, 0);
});

test('an explicit menu line stays ahead of pending clicks', (t) => {
  const { engine, events } = harness(t, { dialogues: clickLines });
  engine.playManual({ id: 'busy' });
  engine.requestTrigger('click_rapid');
  engine.playManual({ id: 'chosen-by-user' });
  engine.onSpeechEnded(sentToken(events));
  assert.equal(events[1].dialogue.id, 'chosen-by-user');
  t.mock.timers.tick(5000);
  engine.onSpeechEnded(sentToken(events, 1));
  assert.equal(events.length, 2);
});

test('malformed trigger state falls back to valid backup and sanitizes its fields before atomic writes', (t) => {
  const backup = {
    date: '2026-09-12', autoCount: 3, lastSpeechAt: 'broken', lastInteractionAt: 0,
    triggerLastAt: [], dialogueLastAt: { corrupt: 'bad', valid: 500 }, greetedSlots: null,
    recentIds: [null, 'remembered'], weatherSignature: []
  };
  const { engine, files, statePath } = harness(t, {}, { state: 'null', backup: JSON.stringify(backup) });
  assert.equal(engine.getDebugState().autoCount, 3);
  assert.equal(engine.getDebugState().lastSpeechAt, 0);
  assert.deepEqual(engine.getDebugState().triggerLastAt, {});
  assert.deepEqual(engine.getDebugState().dialogueLastAt, { valid: 500 });
  assert.deepEqual(engine.getDebugState().recentIds, ['remembered']);
  engine.playManual({ id: 'new-line' });
  assert.equal(JSON.parse(files.get(statePath)).recentIds.at(-1), 'new-line');
  assert.equal(files.get(`${statePath}.bak`), JSON.stringify(backup));
  assert.ok([...files.keys()].every((key) => !key.includes('.tmp-')));
});
