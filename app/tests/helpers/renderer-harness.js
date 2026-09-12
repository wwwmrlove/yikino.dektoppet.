'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const YukinoMouth = require('../../renderer/mouth-controller');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createRendererHarness(control = {}) {
  let now = 1000, nextTimer = 0;
  const timers = new Map();
  const callbacks = {};
  const calls = [];
  const audios = [], contexts = [], errors = [];
  const nodes = new Map();
  const node = () => ({ textContent: '', classList: { add() {}, remove() {} }, addEventListener() {} });
  const setTimer = (fn, ms) => {
    timers.set(++nextTimer, { fn, at: now + ms });
    return nextTimer;
  };
  const desktopPet = new Proxy({}, { get(_target, name) {
    if (String(name).startsWith('on')) return (fn) => { callbacks[name] = fn; };
    return (...args) => { calls.push({ name, args }); return Promise.resolve({}); };
  } });
  class Audio {
    constructor(url) { this.url = url; this.events = {}; this.paused = false; audios.push(this); }
    addEventListener(name, fn) { this.events[name] = fn; }
    play() { return control.play ? control.play(this) : Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.url = ''; }
    load() { this.loaded = true; }
    emit(name) { this.events[name]?.(); }
  }
  class AudioContext {
    constructor() { this.destination = {}; this.nodes = []; contexts.push(this); }
    resume() { return control.resume ? control.resume(this) : Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaElementSource() { return this.createNode(); }
    createAnalyser() { return this.createNode(); }
    createNode() {
      const result = { connect() {}, disconnect() { this.disconnected = true; },
        getFloatTimeDomainData(samples) { samples.fill(0); } };
      this.nodes.push(result);
      return result;
    }
  }
  const context = vm.createContext({
    window: { desktopPet, addEventListener() {}, setTimeout: setTimer,
      clearTimeout: (id) => timers.delete(id), location: { href: 'file:///pet/renderer/index.html' } },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
    performance: { now: () => now }, Audio, AudioContext, URL, Float32Array, YukinoMouth,
    console: { info() {}, warn() {}, error(...args) { errors.push(args); } }
  });
  const source = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  vm.runInContext(source.replace(/\bboot\(\);\s*$/, ''), context);
  vm.runInContext('model = {};', context);
  function run(code) { return vm.runInContext(code, context); }
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = until;
  }
  return { context, callbacks, calls, audios, contexts, errors, timers, run, advance };
}

module.exports = { createRendererHarness, deferred };
