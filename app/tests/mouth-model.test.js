'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mouth = require('../renderer/mouth-controller');
const { createRendererHarness } = require('./helpers/renderer-harness');

async function realModelFixture() {
  const context = vm.createContext({ console, atob, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../vendor/live2dcubismcore.min.js'), 'utf8'), context);
  await new Promise(setImmediate);
  const bytes = fs.readFileSync(path.join(__dirname, '../assets/model/yukino-live2d-final.moc3'));
  const moc = context.Live2DCubismCore.Moc.fromArrayBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  assert.ok(moc, 'The actual packaged moc3 loads in the actual vendor Core');
  const raw = context.Live2DCubismCore.Model.fromMoc(moc);
  const core = {
    setParameterValueById(id, value) { raw.parameters.values[raw.parameters.ids.indexOf(id)] = value; },
    getPartIndex(id) { return raw.parts.ids.indexOf(id); },
    setPartOpacityById(id, value) { raw.parts.opacities[raw.parts.ids.indexOf(id)] = value; },
    getPartOpacityById(id) { return raw.parts.opacities[raw.parts.ids.indexOf(id)]; },
    getDrawableCount() { return raw.drawables.count; },
    getDrawableParentPartIndex(index) { return raw.drawables.parentPartIndices[index]; },
    getDrawableOpacity(index) { return raw.drawables.opacities[index]; },
    update() { raw.update(); }
  };
  return { raw, core, release() { raw.release(); moc._release(); } };
}

test('actual Core + moc3: 9 expressions and the entire speech amplitude range keep exactly one opaque mouth', async () => {
  const fixture = await realModelFixture();
  try {
    const h = createRendererHarness();
    const warnings = [];
    const controller = mouth.create(fixture.core, (id) => id, (...args) => warnings.push(args));
    h.context.testModel = { internalModel: { coreModel: fixture.core, getIdSafe: (id) => id } };
    h.context.testMouth = controller;
    h.run('model = testModel; mouthController = testMouth;');
    const expressions = h.run('Object.keys(EXPRESSION_PARAMETERS)');
    assert.equal(expressions.length, 9);
    const levels = new Set(Array.from({ length: 1001 }, (_, index) => index / 1000));
    for (const boundary of mouth.SPEECH_THRESHOLDS) {
      for (const delta of [-1e-6, 0, 1e-6]) levels.add(boundary + delta);
    }
    let frames = 0;
    for (const expression of expressions) {
      h.context.testExpression = expression;
      h.run('activeExpression = testExpression; isSpeaking = false; speechMouthLevel = 1; applyActiveExpression();');
      fixture.core.update();
      const idle = controller.inspect();
      assert.ok(idle.valid, `${expression}: idle ${JSON.stringify(idle)}`);
      assert.notEqual(idle.expected, 'MOUTH_06_WIDE_OPEN', 'Idle never uses the maximum mouth, even with residual amplitude');
      frames++;
      for (const level of levels) {
        h.context.testLevel = level;
        h.run('isSpeaking = true; speechMouthLevel = testLevel; applyActiveExpression();');
        fixture.core.update();
        const state = controller.inspect();
        assert.ok(state.valid, `${expression} / ${level}: ${JSON.stringify(state)}`);
        if (level < 0.08) assert.equal(state.expected, 'MOUTH_01_CLOSED_NEUTRAL');
        frames++;
      }
    }
    assert.deepEqual(warnings, []);
    assert.equal(frames, 9072);
  } finally { fixture.release(); }
});

test('final Drawable audit catches invisible and doubled artwork, not only enabled Parts', async () => {
  const fixture = await realModelFixture();
  try {
    const warnings = [];
    const controller = mouth.create(fixture.core, (id) => id, (...args) => warnings.push(args));
    controller.apply('worried', false, 0);
    fixture.core.setParameterValueById('ParamMouthForm', 0); // Reproduce rc3 worried mismatch.
    fixture.core.update();
    assert.equal(controller.inspect().visibleParts.length, 1);
    assert.equal(controller.inspect().valid, false);
    assert.equal(warnings.length, 1);
    controller.apply('worried', false, 0);
    fixture.core.setPartOpacityById('MOUTH_04_SMALL_OPEN', 1);
    fixture.core.setParameterValueById('ParamMouthOpenY', 0.3);
    fixture.core.update();
    assert.equal(controller.inspect().visibleDrawables.length, 2);
    assert.equal(controller.inspect().valid, false);
    assert.equal(warnings.length, 1, 'Avoid logging the same failure on every frame');
    controller.apply('worried', false, 0);
    fixture.core.update();
    assert.equal(controller.inspect().valid, true);
  } finally { fixture.release(); }
});
