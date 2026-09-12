'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createJsonStore } = require('../json-store');
const {
  DEFAULT_BEHAVIOR_SETTINGS, createBehaviorSettingsService, normalizeBehaviorSettings, isQuietTime
} = require('../behavior-settings');

const SETTINGS_PATH = path.join('memory', 'behavior-settings.json');

function memoryStore(content, backup) {
  const files = new Map();
  if (content !== undefined) files.set(SETTINGS_PATH, content);
  if (backup !== undefined) files.set(`${SETTINGS_PATH}.bak`, backup);
  let failReplace = false;
  const memoryFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, value) { files.set(file, value); },
    renameSync(source, destination) {
      if (failReplace && destination === SETTINGS_PATH) throw new Error('simulated locked settings');
      if (!files.has(source)) throw new Error('ENOENT');
      files.set(destination, files.get(source));
      files.delete(source);
    },
    unlinkSync(file) { files.delete(file); }
  };
  const storage = createJsonStore(memoryFs);
  return {
    files, storage,
    service: createBehaviorSettingsService({ app: { getPath: () => 'memory' }, storage }),
    lock: () => { failReplace = true; }
  };
}

test('missing, null, array and truncated settings recover defaults or a valid backup', () => {
  const backup = { ...DEFAULT_BEHAVIOR_SETTINGS, proactiveEnabled: false, quietStart: '23:00' };
  for (const content of [undefined, 'null', '[]', '"wrong"', '{']) {
    assert.deepEqual(memoryStore(content).service.get(), DEFAULT_BEHAVIOR_SETTINGS);
    assert.deepEqual(memoryStore(content, JSON.stringify(backup)).service.get(), backup);
  }
});

test('malformed fields normalize without invoking object coercion', () => {
  const broken = { proactiveEnabled: 'false', frequency: { toString: null }, weatherMode: {}, quietStart: { toString: {} }, quietEnd: '25:62' };
  assert.deepEqual(normalizeBehaviorSettings(broken), DEFAULT_BEHAVIOR_SETTINGS);
  assert.deepEqual(memoryStore(JSON.stringify(broken)).service.get(), DEFAULT_BEHAVIOR_SETTINGS);
  for (const value of [null, [], false, 'wrong']) assert.deepEqual(normalizeBehaviorSettings(value), DEFAULT_BEHAVIOR_SETTINGS);
});

test('successful updates persist atomically, preserve untouched fields and expose defensive copies', () => {
  const h = memoryStore(JSON.stringify(DEFAULT_BEHAVIOR_SETTINGS));
  const saved = h.service.update({ frequency: 'quiet', quietStart: '23:00' });
  assert.equal(saved.frequency, 'quiet');
  assert.equal(saved.weatherMode, DEFAULT_BEHAVIOR_SETTINGS.weatherMode);
  assert.deepEqual(JSON.parse(h.files.get(SETTINGS_PATH)), saved);
  assert.deepEqual(JSON.parse(h.files.get(`${SETTINGS_PATH}.bak`)), DEFAULT_BEHAVIOR_SETTINGS);
  saved.frequency = 'chatty';
  assert.equal(h.service.get().frequency, 'quiet');
  assert.equal([...h.files.keys()].some((file) => file.includes('.tmp-')), false);
});

test('a failed atomic replacement preserves both active behavior and the original file', () => {
  const h = memoryStore(JSON.stringify(DEFAULT_BEHAVIOR_SETTINGS));
  h.lock();
  assert.throws(() => h.service.update({ proactiveEnabled: false }), /locked settings/);
  assert.deepEqual(h.service.get(), DEFAULT_BEHAVIOR_SETTINGS);
  assert.deepEqual(JSON.parse(h.files.get(SETTINGS_PATH)), DEFAULT_BEHAVIOR_SETTINGS);
  assert.equal([...h.files.keys()].some((file) => file.includes('.tmp-')), false);
});

test('invalid patch roots reject without changing state', () => {
  const h = memoryStore(JSON.stringify(DEFAULT_BEHAVIOR_SETTINGS));
  for (const patch of [null, [], 'quiet']) {
    assert.throws(() => h.service.update(patch), /格式不正确/);
    assert.deepEqual(h.service.get(), DEFAULT_BEHAVIOR_SETTINGS);
  }
});

test('quiet-time semantics remain correct across midnight and corrupted settings', () => {
  const options = { quietStart: '23:00', quietEnd: '07:00' };
  assert.equal(isQuietTime(new Date(2026, 8, 12, 23, 30), options), true);
  assert.equal(isQuietTime(new Date(2026, 8, 12, 6, 59), options), true);
  assert.equal(isQuietTime(new Date(2026, 8, 12, 7, 0), options), false);
  assert.equal(isQuietTime(new Date(2026, 8, 12, 2, 0), null), true);
});

async function settingsPage(api) {
  const elements = new Map();
  for (const id of ['enabled', 'frequency', 'weather-mode', 'quiet-start', 'quiet-end', 'save', 'message']) {
    const listeners = {};
    elements.set(`#${id}`, {
      value: '', checked: false, disabled: false, textContent: '', listeners,
      addEventListener: (name, callback) => { listeners[name] = callback; }
    });
  }
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector) },
    window: { behaviorSettings: api }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../behavior-settings/renderer.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  return elements;
}

test('settings page reports a rejected save and allows retry without claiming success', async () => {
  const elements = await settingsPage({
    get: async () => DEFAULT_BEHAVIOR_SETTINGS,
    save: async () => { throw new Error('磁盘写入失败'); }
  });
  await elements.get('#save').listeners.click();
  assert.equal(elements.get('#save').disabled, false);
  assert.match(elements.get('#message').textContent, /保存失败.*磁盘写入失败/);
  assert.doesNotMatch(elements.get('#message').textContent, /已立即生效/);
});

test('settings page cannot save blank defaults while initial loading has failed', async () => {
  for (const get of [async () => null, async () => { throw new Error('service unavailable'); }]) {
    const elements = await settingsPage({ get });
    assert.equal(elements.get('#save').disabled, true);
    assert.match(elements.get('#message').textContent, /读取设置失败/);
  }
});
