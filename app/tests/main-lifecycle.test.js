'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainHarness } = require('./helpers/main-harness');

test('recovering a pet after moving to a small negative-coordinate screen fits and relocks dimensions without changing user scale', () => {
  const h = createMainHarness({ initialState: { modelScale: 0.8 } });
  h.ready();
  const pet = h.windows[0];
  assert.equal(pet.bounds.height, 820);
  h.setArea({ x: -900, y: -540, width: 900, height: 540 });
  h.app.emit('second-instance');
  assert.deepEqual(pet.bounds, { x: -444, y: -528, width: 420, height: 516 });
  assert.deepEqual(pet.minimum, [420, 516]);
  assert.deepEqual(pet.maximum, [420, 516]);
  assert.deepEqual(pet.constraints.slice(-4), [['min', 1, 1], ['max', 0, 0], ['min', 420, 516], ['max', 420, 516]]);
  assert.equal(h.run('savedState.modelScale'), 0.8);
  assert.equal(h.windows.length, 2, 'Second launch reuses pet and subtitle windows');
  h.advance(301);
  assert.equal(h.stores.at(-1).value.modelScale, 0.8);
  assert.equal(h.stores.at(-1).value.x, -444);
});

test('display removal and cross-display drag resize a fixed-size pet in both directions', () => {
  const h = createMainHarness(); h.ready();
  const pet = h.windows[0];
  h.setArea({ x: 0, y: 0, width: 360, height: 540 });
  h.screen.emit('display-removed');
  assert.equal(pet.bounds.width, 336);
  assert.equal(pet.bounds.height, 516);
  assert.ok(pet.bounds.x >= 0 && pet.bounds.x + pet.bounds.width <= 360);
  assert.ok(pet.bounds.y + pet.bounds.height <= 540);
  h.setArea({ x: -1920, y: -100, width: 1920, height: 1080 });
  h.ipcMain.emit('pet:move', { sender: pet.webContents }, { x: -1000, y: 0 });
  assert.deepEqual(pet.bounds, { x: -1000, y: 0, width: 420, height: 820 });
  assert.deepEqual(pet.minimum, [420, 820]);
  assert.deepEqual(pet.maximum, [420, 820]);
});

test('speech ended or cancelled before subtitle document load cannot reappear from pending state', () => {
  for (const finish of ["hideSubtitle(7)", "cancelPetSpeech(7, 'timeout')"]) {
    const h = createMainHarness(); h.ready();
    const subtitle = h.windows[1];
    h.run("showSubtitle({token: 7, text: '字幕测试', durationMs: 500})");
    assert.equal(h.run('pendingSubtitle.token'), 7);
    h.run(finish);
    assert.equal(h.run('pendingSubtitle'), null);
    subtitle.webContents.emit('did-finish-load');
    h.advance(901);
    assert.equal(subtitle.webContents.messages.filter(({ channel }) => channel === 'subtitle:show').length, 0);
    assert.equal(Boolean(subtitle.visible), false);
  }
});

test('an obsolete subtitle end never clears the next pending subtitle', () => {
  const h = createMainHarness(); h.ready();
  const subtitle = h.windows[1];
  h.run("showSubtitle({token: 7, text: '上一条'}); showSubtitle({token: 8, text: '下一条'}); hideSubtitle(7)");
  subtitle.webContents.emit('did-finish-load');
  const shown = subtitle.webContents.messages.filter(({ channel }) => channel === 'subtitle:show');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].payload.token, 8);
});

test('only pet renderer readiness releases dispatch; crash recovery is paused and bounded', () => {
  const h = createMainHarness(); h.ready();
  const pet = h.windows[0], subtitle = h.windows[1], engine = h.engines[0];
  assert.equal(engine.options.rendererReady, false);
  h.ipcMain.emit('pet:renderer-ready', { sender: subtitle.webContents });
  assert.equal(engine.calls.filter(({ name }) => name === 'onRendererReady').length, 0);
  h.ipcMain.emit('pet:renderer-ready', { sender: pet.webContents });
  assert.equal(engine.calls.filter(({ name }) => name === 'onRendererReady').length, 1);
  pet.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.run('rendererRecovery.getState()'), 'recovering');
  h.advance(100000);
  assert.equal(pet.webContents.reloads, 3);
  assert.equal(h.run('rendererRecovery.getState()'), 'failed');
  h.app.emit('before-quit');
  h.app.emit('will-quit');
  assert.equal(h.timers.size, 0);
});

test('a process without the single-instance lock never creates windows or starts services', () => {
  const h = createMainHarness({ hasLock: false });
  h.ready();
  assert.equal(h.app.quitCalls, 1);
  assert.equal(h.windows.length, 0);
  assert.equal(h.engines.length, 0);
  assert.equal(h.trays.length, 0);
});
