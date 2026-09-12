'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWeatherService, locationId } = require('../weather-service');
const { harness, sentToken } = require('./helpers/trigger-engine-harness');

function integration(t) {
  let service;
  let settings = { quietStart: '00:00', quietEnd: '00:00', weatherMode: 'all' };
  const holding = { id: 'holding', translation: '正在说话。' };
  const thunder = { id: 'thunder', autoEnabled: true, triggers: ['weather_thunder'], translation: '出门记得带伞。' };
  const h = harness(t, {
    dialogues: [holding, thunder],
    getWeatherContext: () => service?.getContext(),
    getBehaviorSettings: () => settings
  });
  const location = { enabled: true, city: '北京市朝阳区', latitude: 39.95, longitude: 116.48, timezone: 'Asia/Shanghai' };
  const initialCache = {
    locationId: locationId(location), fetchedAt: Date.now(),
    current: { temperature: 20, apparentTemperature: 20, precipitation: 10, weatherCode: 95, windSpeed: 10 }
  };
  const files = new Map([
    ['weather-settings.json', location], ['weather-cache.json', initialCache]
  ]);
  const requests = [];
  service = createWeatherService({
    app: { getPath: () => '__weather_memory__' },
    storage: {
      readJson: (file, fallback) => structuredClone(files.get(path.basename(file)) ?? fallback),
      writeJson: (file, value) => files.set(path.basename(file), structuredClone(value))
    },
    resolveLocation: () => ({ province: '上海市', city: '上海市', district: '黄浦区', level: '区县', latitude: 31.21, longitude: 121.48 }),
    fetchImpl: () => new Promise((resolve, reject) => requests.push({
      reject,
      resolve: (temperature) => resolve({ ok: true, json: async () => ({
        current: { temperature_2m: temperature, apparent_temperature: temperature, precipitation: 10, weather_code: 95, wind_speed_10m: 10 }
      }) })
    })),
    onUpdate: (next, previous, meta) => h.engine.handleWeatherUpdate(next, previous, meta)
  });
  t.after(() => service.stop());
  return { ...h, service, holding, requests, files, changeBehavior: (next) => { settings = { ...settings, ...next }; h.engine.onSettingsChanged(); } };
}

test('disabling the real weather service removes a queued explicit weather request', (t) => {
  const h = integration(t);
  assert.equal(h.engine.playManual(h.holding), true);
  assert.equal(h.engine.announceWeather(), true);
  assert.equal(h.engine.getDebugState().eventQueue.length, 1);
  h.service.disable();
  assert.equal(h.engine.getDebugState().eventQueue.length, 0);
  assert.equal(h.engine.onSpeechEnded(sentToken(h.events)), true);
  assert.equal(h.events.filter((event) => event.type === 'send').length, 1);
});

test('switching city clears queued weather before a new-city failed fetch returns', async (t) => {
  const h = integration(t);
  h.engine.playManual(h.holding);
  h.engine.announceWeather();
  const pending = h.service.setCity('上海市黄浦区');
  assert.equal(h.engine.getDebugState().eventQueue.length, 0);
  h.requests[0].reject(new Error('offline'));
  await pending;
  assert.equal(h.engine.onSpeechEnded(sentToken(h.events)), true);
  assert.equal(h.events.filter((event) => event.type === 'send').length, 1);
  assert.equal(h.service.getContext(), null);
});

test('queued explicit weather rebuilds its subtitle from the newest same-city cache', async (t) => {
  const h = integration(t);
  h.engine.playManual(h.holding);
  h.engine.announceWeather();
  const pending = h.service.refresh(true);
  h.requests[0].resolve(24);
  await pending;
  assert.equal(h.engine.onSpeechEnded(sentToken(h.events)), true);
  const sent = h.events.filter((event) => event.type === 'send');
  assert.equal(sent.length, 2);
  assert.match(sent[1].dialogue.translation, /北京市朝阳区.*24℃/);
  assert.doesNotMatch(sent[1].dialogue.translation, /20℃/);
});

test('turning off proactive weather still permits an already requested manual report', (t) => {
  const h = integration(t);
  h.engine.playManual(h.holding);
  h.engine.announceWeather();
  h.changeBehavior({ weatherMode: 'off' });
  assert.equal(h.engine.onSpeechEnded(sentToken(h.events)), true);
  const sent = h.events.filter((event) => event.type === 'send');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].dialogue.id, 'thunder');
});
