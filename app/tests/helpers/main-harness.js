'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createMainHarness({ initialState = {}, hasLock = true } = {}) {
  const windows = [], stores = [], engines = [], trays = [];
  const timers = new Map();
  let now = 0, nextTimer = 0;
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  const schedule = (fn, ms, repeat = false) => {
    timers.set(++nextTimer, { fn, at: now + ms, ms, repeat });
    return nextTimer;
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, commandLine: { appendSwitch() {} },
    getPath() { return 'C:/virtual-yukino-profile'; },
    setPath() {}, requestSingleInstanceLock() { return hasLock; },
    quit() { this.quitCalls = (this.quitCalls || 0) + 1; }
  });
  class WebContents extends EventEmitter {
    constructor() { super(); this.messages = []; }
    send(channel, payload) { this.messages.push({ channel, payload }); }
    isDestroyed() { return Boolean(this.destroyed); }
    reload() { this.reloads = (this.reloads || 0) + 1; this.emit('did-start-loading'); }
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: options.x || 0, y: options.y || 0,
        width: options.width, height: options.height };
      this.minimum = [options.minWidth || 1, options.minHeight || 1];
      this.maximum = [options.maxWidth || Infinity, options.maxHeight || Infinity];
      this.webContents = new WebContents(); this.constraints = []; windows.push(this);
    }
    getBounds() { return { ...this.bounds }; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    setMinimumSize(w, h) { this.minimum = [w, h]; this.constraints.push(['min', w, h]); }
    setMaximumSize(w, h) { this.maximum = [w || Infinity, h || Infinity]; this.constraints.push(['max', w, h]); }
    setBounds(bounds) {
      const previous = this.bounds;
      this.bounds = { ...previous, ...bounds };
      this.bounds.width = Math.min(this.maximum[0], Math.max(this.minimum[0], this.bounds.width));
      this.bounds.height = Math.min(this.maximum[1], Math.max(this.minimum[1], this.bounds.height));
      if (previous.x !== this.bounds.x || previous.y !== this.bounds.y) this.emit('move');
    }
    setPosition(x, y) { this.setBounds({ x, y }); }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
    loadFile(file) { this.file = file; this.webContents.emit('did-start-loading'); return Promise.resolve(); }
    setIgnoreMouseEvents(value) { this.ignoreMouseEvents = value; }
    showInactive() { this.visible = true; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    setMenuBarVisibility() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBackgroundColor() {}
  }
  class Tray extends EventEmitter {
    constructor() { super(); trays.push(this); }
    isDestroyed() { return Boolean(this.destroyed); }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip(text) { this.tooltip = text; }
    destroy() { this.destroyed = true; }
  }
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: area }),
    getDisplayMatching: () => ({ workArea: area }),
    getDisplayNearestPoint: () => ({ workArea: area }),
    getCursorScreenPoint: () => ({ x: area.x + 100, y: area.y + 100 })
  });
  const ipcMain = Object.assign(new EventEmitter(), { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } });
  const engineFactory = { createTriggerEngine(options) {
    const engine = { options, calls: [], onSpeechStarted: () => true, onSpeechEnded: () => true };
    for (const name of ['onRendererUnavailable', 'onRendererReady', 'start', 'stop', 'handleWeatherUpdate',
      'playManual', 'handleInteraction', 'onSettingsChanged']) engine[name] = (...args) => engine.calls.push({ name, args });
    engines.push(engine); return engine;
  } };
  const modules = {
    electron: { app, BrowserWindow, ipcMain, screen, Tray, powerMonitor: new EventEmitter(),
      globalShortcut: { register: () => true, unregisterAll() {} },
      nativeImage: { createFromBitmap: () => ({}) }, Menu: { buildFromTemplate: (items) => items } },
    fs: { readFileSync() { return '{"dialogues":[]}'; } }, path,
    './trigger-engine': engineFactory,
    './weather-service': { createWeatherService: () => ({ start() {}, stop() {}, getContext: () => null }) },
    './behavior-settings': { createBehaviorSettingsService: () => ({ get: () => ({}) }) },
    './json-store': { createJsonStore: () => ({ read: () => ({ ...initialState }), write(file, value) { stores.push({ file, value: { ...value } }); } }) },
    './safe-logging': { installSafeLogging() {} }
  };
  const context = vm.createContext({
    require(name) { return modules[name] || require(path.join(__dirname, '../..', name)); },
    __dirname: path.join(__dirname, '../..'), process: { env: {}, pid: 123 }, Buffer,
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: (id) => timers.delete(id),
    setImmediate: (fn) => schedule(fn, 0)
  });
  // Keep recovery timers inside the same isolated clock as the main process.
  const recoverySource = fs.readFileSync(path.join(__dirname, '../../renderer-recovery.js'), 'utf8')
    .replace('module.exports = { createRendererRecovery };', 'globalThis.recoveryFactory = createRendererRecovery;');
  vm.runInContext(`(() => { ${recoverySource} })()`, context);
  modules['./renderer-recovery'] = { createRendererRecovery: context.recoveryFactory };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      if (due[1].repeat) due[1].at += due[1].ms;
      else timers.delete(due[0]);
      due[1].fn();
    }
    now = until;
  }
  return { app, windows, stores, engines, trays, screen, ipcMain, context, timers, run, advance,
    setArea(value) { area = value; }, ready() { app.emit('ready'); } };
}

module.exports = { createMainHarness };
