'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createTriggerEngine } = require('../../trigger-engine');

// All state IO and time are isolated: even a broken implementation can only
// access this in-memory fake directory, never the user's Electron settings.
function harness(t, overrides = {}, initial = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 12, 12).getTime() });
  const fakeUserData = path.resolve('__isolated_trigger_test_userdata__');
  const statePath = path.join(fakeUserData, 'trigger-state.json');
  const files = new Map();
  if (Object.hasOwn(initial, 'state')) files.set(statePath, initial.state);
  if (Object.hasOwn(initial, 'backup')) files.set(`${statePath}.bak`, initial.backup);
  const allowedFile = (file) => {
    assert.ok(file === statePath || file === `${statePath}.bak` || file.startsWith(`${statePath}.tmp-`)
      || file.startsWith(`${statePath}.bak.tmp-`), `Unexpected filesystem access: ${file}`);
  };
  t.mock.method(fs, 'readFileSync', (file) => {
    allowedFile(file);
    if (!files.has(file)) throw new Error('Test state starts empty');
    return files.get(file);
  });
  t.mock.method(fs, 'mkdirSync', (directory) => assert.equal(directory, fakeUserData));
  t.mock.method(fs, 'writeFileSync', (file, content) => {
    allowedFile(file);
    files.set(file, content);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    allowedFile(source);
    allowedFile(destination);
    assert.ok(files.has(source));
    files.set(destination, files.get(source));
    files.delete(source);
  });
  t.mock.method(fs, 'unlinkSync', (file) => {
    allowedFile(file);
    files.delete(file);
  });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const events = [];
  const powerMonitor = new EventEmitter();
  powerMonitor.getSystemIdleTime = () => 0;
  const options = {
    app: { getPath: (name) => { assert.equal(name, 'userData'); return fakeUserData; } },
    powerMonitor,
    dialogues: [{ id: 'scheduled', autoEnabled: true, triggers: ['system_resume', 'time_noon'] }],
    sendSpeech: (dialogue) => events.push({ type: 'send', dialogue }),
    cancelSpeech: (token, reason) => events.push({ type: 'cancel', token, reason }),
    getBehaviorSettings: () => ({ quietStart: '00:00', quietEnd: '00:00' }),
    ...overrides
  };
  const engine = createTriggerEngine(options);
  t.after(() => engine.stop());
  return { engine, events, errors, files, powerMonitor, options, statePath };
}

function sentToken(events, index = 0) {
  return events.filter((event) => event.type === 'send')[index].dialogue.speechToken;
}

module.exports = { harness, sentToken };
