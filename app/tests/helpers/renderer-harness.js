'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const YukinoMouth = require('../../renderer/mouth-controller');

// Part ids the mouth controller touches; getPartIndex must resolve these or it
// cannot tell which drawables belong to which mouth.
const MOUTH_PART_IDS = [
  'MOUTH_00_DEFAULT_EXACT', 'MOUTH_01_CLOSED_NEUTRAL', 'MOUTH_02_SMILE',
  'MOUTH_03_TROUBLED_FLAT', 'MOUTH_04_SMALL_OPEN', 'MOUTH_05_MEDIUM_OPEN',
  'MOUTH_06_WIDE_OPEN', 'MOUTH_07_ROUNDED_VOWEL'
];

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
  // Model double: records every drawable parameter the renderer applies.
  //
  // This used to be `model = {}`, which made applyActiveExpression() return at
  // its `if (!core) return` guard, so the expression tests only ever asserted
  // state variables and never a single applied parameter.
  const modelParameters = new Map();
  const modelPartOpacities = new Map();
  const parameterLog = [];
  const setParameterValueById = (id, value) => {
    if (id === undefined || id === null) return;
    modelParameters.set(id, value);
    parameterLog.push({ id, value });
  };
  const modelCore = {
    setParameterValueById,
    getParameterValueById: (id) => modelParameters.get(id),
    getParameterIndex: (id) => (id === undefined ? -1 : 0),
    getPartIndex: (id) => MOUTH_PART_IDS.indexOf(id),
    setPartOpacityById: (id, value) => modelPartOpacities.set(id, value),
    getPartOpacityById: (id) => modelPartOpacities.get(id) ?? 0,
    getDrawableCount: () => 0,
    getDrawableParentPartIndex: () => -1,
    getDrawableOpacity: () => 0,
    update() {}
  };
  vm.runInContext('model = null;', context);
  context.modelCore = modelCore;
  vm.runInContext('getIdSafe = (id) => id;', context);
  vm.runInContext(
    'model = { internalModel: { coreModel: modelCore, getIdSafe: (id) => id, on() {} } };',
    context
  );
  // Real mouth controller over the recording core, so applyActiveExpression()
  // exercises the actual pose selection instead of a no-op optional call.
  const mouthViolations = [];
  const controller = YukinoMouth.create(
    modelCore,
    (id) => id,
    (...args) => mouthViolations.push(args)
  );
  context.testMouthController = controller;
  vm.runInContext('mouthController = testMouthController;', context);

  function run(code) { return vm.runInContext(code, context); }
  // Simulates one rendered frame: the engine emits beforeModelUpdate, which is
  // what applyActiveExpression is registered for. Tests call this instead of
  // calling applyActiveExpression() by hand.
  function applyFrame() {
    run('applyActiveExpression();');
    return { parameters: new Map(modelParameters), log: parameterLog.slice() };
  }
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
  return {
    context, callbacks, calls, audios, contexts, errors, timers, run, advance, applyFrame,
    modelParameters, modelPartOpacities, parameterLog, modelCore, mouthViolations,
    mouthController: controller,
    parameter: (id) => modelParameters.get(id),
    clearParameterLog: () => { parameterLog.length = 0; }
  };
}

module.exports = { createRendererHarness, deferred };
