'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJsonStore } = require('../json-store');

test('invalid root and truncated JSON fall back to a last valid snapshot', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yukino-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); const store = createJsonStore(fs);
  for(const content of ['null', '[]', '"string"', '{']) {
    fs.writeFileSync(file, content); assert.deepEqual(store.read(file, {x:1}), {x:1});
  }
  store.write(file, {x:10}); store.write(file, {x:20});
  fs.writeFileSync(file, '{'); assert.deepEqual(store.read(file), {x:10});
});

test('failed replace preserves old file, cleans its temporary and does not corrupt backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yukino-state-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); createJsonStore(fs).write(file, {x:10});
  const store = createJsonStore({...fs, renameSync(source, dest) {
    if(dest===file) throw Error('simulated locked file'); fs.renameSync(source,dest);
  }});
  assert.throws(() => store.write(file, {x:20}));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {x:10});
  assert.deepEqual(store.read(file+'.bak'), {x:10});
  assert.equal(fs.readdirSync(dir).some(name=>name.includes('.tmp-')), false);
});
