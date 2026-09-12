'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createWeatherService, locationId } = require('../weather-service');

const START = Date.UTC(2026, 8, 12, 6, 30);
const SETTINGS_PATH = path.join('memory', 'weather-settings.json');
const CACHE_PATH = path.join('memory', 'weather-cache.json');
const CITY_A = { enabled: true, city: '北京市朝阳区', latitude: 39.95, longitude: 116.48, timezone: 'Asia/Shanghai' };
const CITY_B = { enabled: true, city: '上海市黄浦区', latitude: 31.21, longitude: 121.48, timezone: 'Asia/Shanghai' };

function cached(settings = CITY_A, temperature = 33) {
  return {
    version: 2, locationId: locationId(settings), fetchedAt: START - 1000,
    current: { temperature, apparentTemperature: temperature, precipitation: 0, weatherCode: 0, windSpeed: 5 },
    daily: { temperatureMax: temperature + 2, temperatureMin: temperature - 5, precipitationProbability: 10 }
  };
}

function weatherPayload(temperature) {
  return {
    current: { temperature_2m: temperature, apparent_temperature: temperature, precipitation: 0, weather_code: 0, wind_speed_10m: 5 },
    daily: { temperature_2m_max: [temperature + 2], temperature_2m_min: [temperature - 5], precipitation_probability_max: [10] }
  };
}

function harness({ settings = CITY_A, cache = cached() } = {}) {
  const files = new Map([[SETTINGS_PATH, structuredClone(settings)], [CACHE_PATH, structuredClone(cache)]]);
  const requests = [];
  const updates = [];
  const pendingTimers = new Map();
  let timerId = 0;
  let time = START;
  const storage = {
    readJson: (file, fallback) => structuredClone(files.has(file) ? files.get(file) : fallback),
    writeJson: (file, value) => files.set(file, structuredClone(value))
  };
  const timers = {
    setTimeout: (callback, delay) => { pendingTimers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => pendingTimers.delete(id),
    setInterval: (callback, delay) => { pendingTimers.set(++timerId, { callback, delay, interval: true }); return timerId; },
    clearInterval: (id) => pendingTimers.delete(id)
  };
  const options = {
    app: { getPath: () => 'memory' }, storage, timers, now: () => time,
    resolveLocation: (query) => {
      const city = query === '北京市朝阳区' ? CITY_A : query === '上海市黄浦区' ? CITY_B : null;
      return city ? { ...city, province: city.city.slice(0, 3), city: city.city.slice(0, 3), district: city.city.slice(3), level: '区县' } : null;
    },
    onUpdate: (...args) => updates.push(args),
    // Deliberately allow aborted responses to resolve: request-version checks
    // must protect state even when a provider or mock ignores AbortSignal.
    fetchImpl: (url, init) => new Promise((resolve, reject) => requests.push({
      url, signal: init.signal, reject,
      resolve: (payload) => resolve({ ok: true, json: async () => payload })
    }))
  };
  return {
    service: createWeatherService(options), recreate: () => createWeatherService(options),
    files, requests, updates, pendingTimers,
    advance: (duration) => { time += duration; }
  };
}

test('legacy and mismatched caches cannot be relabelled with the selected city', () => {
  const legacy = cached();
  delete legacy.locationId;
  for (const cache of [legacy, cached(CITY_B), null, [], {}]) {
    const { service } = harness({ cache });
    assert.equal(service.getContext(), null);
    assert.equal(service.getStatus().lastSuccessAt, null);
  }
  for (const settings of [null, [], 'broken']) {
    assert.equal(harness({ settings }).service.getStatus().settings.enabled, false);
  }
  assert.equal(harness({ settings: { ...CITY_A, city: {} } }).service.getStatus().settings.enabled, false);
});

test('switching city persists invalidation before a failed fetch and restart', async () => {
  const h = harness();
  const result = h.service.setCity(CITY_B.city);
  assert.equal(h.service.getContext(), null);
  assert.deepEqual(h.files.get(CACHE_PATH), {});
  assert.equal(h.files.get(SETTINGS_PATH).city, CITY_B.city);
  assert.equal(h.updates[0][0], null);
  assert.equal(h.updates[0][1].city, CITY_A.city);
  assert.equal(h.updates[0][2].reason, 'location-changed');
  h.requests[0].reject(new Error('offline'));
  const status = await result;
  assert.equal(status.operation.outcome, 'failed');
  assert.equal(status.operation.settingsSaved, true);
  assert.equal(h.recreate().getContext(), null);
});

test('a late weather response cannot overwrite a newer city response', async () => {
  const h = harness();
  const oldRequest = h.service.refresh(true);
  const newRequest = h.service.setCity(CITY_B.city);
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[1].resolve(weatherPayload(11));
  await newRequest;
  h.requests[0].resolve(weatherPayload(35));
  assert.equal((await oldRequest).operation.outcome, 'superseded');
  assert.equal(h.service.getContext().city, CITY_B.city);
  assert.equal(h.service.getContext().temperature, 11);
  assert.equal(h.files.get(CACHE_PATH).locationId, locationId(CITY_B));
  assert.equal(h.service.getStatus().updating, false);
});

test('out-of-order geocoding cannot change the newest location', async () => {
  const h = harness();
  const older = h.service.setCity('London');
  const newer = h.service.setCity('Paris');
  h.requests[1].resolve({ results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35, timezone: 'Europe/Paris' }] });
  await new Promise((resolve) => setImmediate(resolve));
  h.requests[2].resolve(weatherPayload(18));
  await newer;
  h.requests[0].resolve({ results: [{ name: 'London', latitude: 51.5, longitude: -0.12, timezone: 'Europe/London' }] });
  assert.equal((await older).operation.outcome, 'superseded');
  assert.equal(h.service.getContext().city, 'Paris');
  assert.equal(h.requests.length, 3);
});

test('disable invalidates pending forecast and geocoding results immediately', async () => {
  for (const operation of ['refresh', 'setCity']) {
    const h = harness();
    const pending = operation === 'refresh' ? h.service.refresh(true) : h.service.setCity('Paris');
    h.service.disable();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.updates.at(-1)[0], null);
    assert.equal(h.updates.at(-1)[2].reason, 'disabled');
    h.requests[0].resolve(operation === 'refresh' ? weatherPayload(20) : { results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35 }] });
    assert.equal((await pending).operation.outcome, 'superseded');
    assert.equal(h.service.getContext(), null);
    assert.equal(h.files.get(SETTINGS_PATH).enabled, false);
    assert.equal(h.pendingTimers.size, 0);
  }
});

test('refresh failure preserves only the same location cache and successful timestamp', async () => {
  const h = harness();
  const pending = h.service.refresh(true);
  h.requests[0].reject(new Error('network unavailable'));
  const failed = await pending;
  assert.equal(failed.context.temperature, 33);
  assert.equal(failed.lastSuccessAt, START - 1000);
  assert.equal(failed.dataSource, 'offline-cache');
  assert.equal(failed.operation.outcome, 'failed');
  assert.equal(h.updates.at(-1)[2].reason, 'refresh-failed');
  const recovered = h.service.refresh(true);
  h.requests[1].resolve(weatherPayload(29));
  const fresh = await recovered;
  assert.equal(fresh.lastError, '');
  assert.equal(fresh.lastSuccessAt, START);
  assert.equal(fresh.dataSource, 'live');
  assert.equal(h.pendingTimers.size, 0);
});

test('incomplete provider response cannot overwrite valid cache', async () => {
  const h = harness();
  const pending = h.service.refresh(true);
  h.requests[0].resolve({ current: { temperature_2m: null } });
  assert.equal((await pending).operation.outcome, 'failed');
  assert.equal(h.service.getContext().temperature, 33);
  assert.equal(h.files.get(CACHE_PATH).current.temperature, 33);
});

test('fresh cache avoids network; expired cache keeps timestamp but cannot drive reminders', async () => {
  const h = harness();
  assert.equal((await h.service.refresh()).operation.outcome, 'cached');
  assert.equal(h.requests.length, 0);
  h.advance(6 * 60 * 60 * 1000);
  assert.equal(h.service.getContext(), null);
  assert.equal(h.service.getStatus().dataSource, 'expired');
  assert.equal(h.service.getStatus().lastSuccessAt, START - 1000);
});

test('stop clears startup/retry timers and invalidates an in-flight fetch', async () => {
  const h = harness();
  h.service.start();
  const pending = h.service.refresh(true);
  h.service.stop();
  assert.equal(h.pendingTimers.size, 1); // Only the fetch timeout remains until its promise settles.
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].resolve(weatherPayload(24));
  assert.equal((await pending).operation.outcome, 'superseded');
  assert.equal(h.pendingTimers.size, 0);
  assert.equal(h.service.getContext().temperature, 33);
});

function settingsPage(status) {
  const elements = new Map();
  for (const id of ['city', 'save', 'refresh', 'disable', 'status-title', 'status-detail', 'message']) {
    elements.set(`#${id}`, { value: '', disabled: false, textContent: '', addEventListener() {} });
  }
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector), activeElement: null },
    window: { weatherSettings: { getStatus: async () => status } },
    status
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../weather-settings/renderer.js'), 'utf8'), context);
  return { context, elements };
}

test('settings page reports fetch failures and cache age instead of a success message', async () => {
  const h = harness();
  const pending = h.service.refresh(true);
  h.requests[0].reject(new Error('offline'));
  const status = await pending;
  const page = settingsPage(status);
  await vm.runInContext("run(async () => status, '天气已经刷新。')", page.context);
  assert.match(page.elements.get('#message').textContent, /天气获取失败/);
  assert.doesNotMatch(page.elements.get('#message').textContent, /已经刷新/);
  assert.match(page.elements.get('#status-detail').textContent, /获取失败，正在使用缓存/);
  assert.match(page.elements.get('#status-detail').textContent, /最后成功更新/);
  page.context.status = { ...status, updating: true };
  vm.runInContext('render(status)', page.context);
  assert.equal(page.elements.get('#disable').disabled, false);
});

test('settings page does not let a cancelled older operation overwrite disable feedback', async () => {
  const h = harness();
  const page = settingsPage(h.service.getStatus());
  let completeOlder;
  page.context.older = new Promise((resolve) => { completeOlder = resolve; });
  const older = vm.runInContext("run(() => older, '天气已经刷新。')", page.context);
  page.context.disabled = h.service.disable();
  await vm.runInContext("run(async () => disabled, '天气主动台词已停用。')", page.context);
  completeOlder({ ...h.service.getStatus(), operation: { kind: 'refresh', outcome: 'superseded' } });
  await older;
  assert.equal(page.elements.get('#message').textContent, '天气主动台词已停用。');
  assert.equal(page.elements.get('#status-title').textContent, '天气功能已停用');
});
