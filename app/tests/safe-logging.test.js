'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installSafeLogging } = require('../safe-logging');

function fixture(overrides = {}) {
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  const saved = [], originalCalls = [];
  const consoleObject = Object.fromEntries(['log','info','warn','error','debug'].map(level => [level,
    (...args) => { originalCalls.push(level); if(overrides.error) throw overrides.error; }]));
  const fileSystem = {mkdirSync(){}, statSync:()=>({size:0}), appendFileSync(_file, text){saved.push(text);}, ...overrides.fs};
  const installed = installSafeLogging({stdout,stderr,consoleObject,fileSystem,logFile:'test/main.log'});
  return {stdout,stderr,saved,originalCalls,consoleObject,installed};
}

test('synchronous EPIPE cannot escape console forwarding and subsequent logs stay in file', () => {
  const f = fixture({error:Object.assign(new Error('broken pipe'), {code:'EPIPE'})});
  assert.doesNotThrow(() => f.consoleObject.log('renderer ready'));
  assert.doesNotThrow(() => f.consoleObject.log('still alive'));
  assert.equal(f.originalCalls.length, 1);
  assert.match(f.saved.join(''), /renderer ready[\s\S]*still alive/);
  f.installed.dispose();
});

test('asynchronous stdout/stderr pipe errors disable only that sink; storage failures are safe', () => {
  const f = fixture({fs:{appendFileSync(){throw new Error('disk unavailable');}}});
  assert.doesNotThrow(() => f.stdout.emit('error', {code:'EPIPE'}));
  f.consoleObject.log('no pipe'); f.consoleObject.error('stderr remains available');
  assert.deepEqual(f.originalCalls, ['error']);
  assert.doesNotThrow(() => f.stderr.emit('error', {code:'ERR_STREAM_DESTROYED'}));
  assert.doesNotThrow(() => f.consoleObject.error('both pipes closed'));
  f.installed.dispose();
  assert.equal(f.stdout.listenerCount('error'), 0);
});

test('unrelated exceptions are not swallowed', () => {
  const error = new Error('real programming bug');
  const f = fixture({error});
  assert.throws(() => f.consoleObject.log('test'), error);
  assert.throws(() => f.stderr.emit('error', error), error);
  f.installed.dispose();
});

test('diagnostic retention rotates and caps individual messages', () => {
  const rotated = [];
  const f = fixture({fs:{statSync:()=>({size:2*1024*1024}),renameSync:(...args)=>rotated.push(args)}});
  f.consoleObject.warn('x'.repeat(100000));
  assert.equal(rotated.length, 1);
  assert.ok(f.saved[0].length < 17000);
  f.installed.dispose();
});
