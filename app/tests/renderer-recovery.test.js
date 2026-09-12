'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererRecovery } = require('../renderer-recovery');

function fixture() {
  let now = 0, next = 0;
  const timers = new Map();
  const calls = { pause: 0, resume: 0, reload: 0, exhausted: 0 };
  const recovery = createRendererRecovery({
    ...Object.fromEntries(Object.keys(calls).map(name => [name, () => calls[name]++])),
    setTimer(fn, ms) { timers.set(++next, { fn, at: now + ms }); return next; },
    clearTimer(id) { timers.delete(id); }
  });
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn();
    }
    now = end;
  }
  return { recovery, calls, timers, advance };
}

test('unresponsive model has bounded retries and a manual recovery path', () => {
  const f = fixture(); f.recovery.loading(); f.advance(100000);
  assert.equal(f.calls.reload, 3);
  assert.equal(f.calls.exhausted, 1);
  assert.equal(f.recovery.getState(), 'failed');
  f.advance(100000); assert.equal(f.calls.reload, 3);
  f.recovery.retry(); assert.equal(f.calls.reload, 4);
  f.recovery.ready(); assert.equal(f.calls.resume, 1);
});

test('successful ready cancels boot deadline; rapid crash loops remain bounded', () => {
  const f = fixture();
  for(let i=0;i<3;i++) {
    f.recovery.loading(); f.recovery.ready(); f.recovery.failed('crash'); f.advance(4000);
  }
  f.recovery.ready(); f.recovery.failed('crash');
  assert.equal(f.calls.reload, 3); assert.equal(f.calls.exhausted, 1);
});

test('stable renderer resets retry budget; disposal cancels all callbacks', () => {
  const f = fixture(); f.recovery.loading(); f.recovery.failed(); f.advance(1000);
  f.recovery.ready(); f.advance(60000); f.recovery.failed(); f.advance(1000);
  assert.equal(f.calls.reload, 2);
  f.recovery.dispose(); assert.equal(f.timers.size, 0);
  f.advance(100000); assert.equal(f.calls.reload, 2);
});
