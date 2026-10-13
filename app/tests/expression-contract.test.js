'use strict';

// Contract and regression tests for the click -> expression -> mouth path.
//
// These cover the gaps that let a set of real defects ship in rc4:
//   * the expression whitelist existed in three places and had drifted;
//   * renderer-harness. `model` was an empty object, so no test ever observed
//     an applied drawable parameter;
//   * a click during speech produced no expression at all while still queueing
//     its line;
//   * the rapid-click debounce reported one burst twice;
//   * a stale restore timer could overwrite a newer expression decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const mouth = require('../renderer/mouth-controller');
const {
  SELECTABLE_EXPRESSIONS,
  EXPRESSION_NAMES,
  INTERNAL_EXPRESSIONS,
  isSelectableExpression
} = require('../expression-constants');
const { createRendererHarness } = require('./helpers/renderer-harness');

function idlePoseNames() {
  return Object.keys(mouth.IDLE_POSE);
}

function speak(h, token, expression = 'annoyed') {
  h.context.testDialogue = { speechToken: token, expression, file: 'generated/test.wav' };
  return h.run('speakDialogue(testDialogue)');
}

async function startLine(h, token, expression) {
  const pending = speak(h, token, expression);
  await new Promise(setImmediate);
  return pending;
}

test('menu, renderer and mouth tables agree on one expression set', () => {
  const h = createRendererHarness();
  const rendererExpressions = h.run('Object.keys(EXPRESSION_PARAMETERS)');

  // Every selectable name must exist in both consumers.
  for (const { name, label } of SELECTABLE_EXPRESSIONS) {
    assert.ok(label, `${name} needs a menu label`);
    assert.ok(rendererExpressions.includes(name), `${name} missing from EXPRESSION_PARAMETERS`);
    assert.ok(idlePoseNames().includes(name), `${name} missing from mouth IDLE_POSE`);
  }

  // Every renderer expression must have a mouth pose, otherwise the eyes follow
  // the new expression while the mouth silently stays on the default pose.
  for (const name of rendererExpressions) {
    assert.ok(
      idlePoseNames().includes(name),
      `${name} is in EXPRESSION_PARAMETERS but has no IDLE_POSE entry`
    );
  }

  // Internal-only expressions must not be user-selectable.
  for (const name of INTERNAL_EXPRESSIONS) {
    assert.match(name, /^speak_/, 'only speak_* expressions are internal');
    assert.equal(isSelectableExpression(name), false, `${name} must stay internal`);
  }
  assert.ok(!EXPRESSION_NAMES.includes('speak_a'));
});

test('a dialogue expression always produces an applied parameter change', async () => {
  const h = createRendererHarness();
  h.clearParameterLog();
  await speak(h, 1, 'worried');
  h.applyFrame();
  assert.equal(h.parameter('ParamExpression'), 5, 'worried must set ParamExpression=5');
  assert.equal(h.run('activeExpression'), 'worried');
});

test('selecting closed keeps a matching mouth pose instead of desyncing', () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('closed');
  h.applyFrame();
  assert.equal(h.run('activeExpression'), 'closed');
  assert.equal(h.run('persistentExpression'), 'closed');
  // MOUTH_01_CLOSED_NEUTRAL is POSES[1]; the controller must have selected it.
  assert.equal(h.modelPartOpacities.get('MOUTH_01_CLOSED_NEUTRAL'), 1);
  assert.equal(h.modelPartOpacities.get('MOUTH_00_DEFAULT_EXACT'), 0);
  assert.deepEqual(h.mouthViolations, [], 'idle mouth pose must stay valid');
});

test('an unknown expression never silently falls back to the default mouth', () => {
  const h = createRendererHarness();
  // Drive the pure pose selector with a name no table contains.
  const pose = h.mouthController.apply('not_a_real_expression', false, 0);
  assert.equal(pose.part, 'MOUTH_00_DEFAULT_EXACT', 'falls back, as before');
  assert.ok(
    h.mouthViolations.length >= 1,
    'a missing IDLE_POSE entry must be reported, not swallowed'
  );
});

test('a click during speech shows its reaction when the line ends, not never', async () => {
  const h = createRendererHarness();
  await speak(h, 1, 'default');
  assert.equal(h.run('isSpeaking'), true);

  // Three quick clicks while the line is playing.
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()');
  assert.equal(h.run('activeExpression'), 'default', 'must not interrupt the playing line');
  assert.equal(h.run('pendingClickFeedback !== null'), true, 'reaction must be remembered');

  // The queued click line finally starts, then ends.
  await speak(h, 2, 'annoyed');
  h.audios[1].emit('ended');

  // The deferred reaction is applied on the next animation frame.
  h.run('updateSpeechMouth();');
  assert.ok(
    ['annoyed', 'surprised', 'soft_smile'].includes(h.run('activeExpression')),
    `expected a click reaction, got ${h.run('activeExpression')}`
  );
  h.advance(2000);
  assert.equal(h.run('activeExpression'), h.run('persistentExpression'));
});

test('a manual selection outranks a click reaction that has not been shown yet', async () => {
  const h = createRendererHarness();
  await speak(h, 1, 'default');
  h.run('registerInteractionClick()');
  assert.equal(h.run('pendingClickFeedback !== null'), true);
  h.callbacks.onExpression('worried');
  h.audios[0].emit('ended');
  h.run('updateSpeechMouth();');
  assert.equal(h.run('activeExpression'), 'worried');
});

test('one rapid burst reports exactly one interaction type', () => {
  const h = createRendererHarness();
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()');
  const reported = () => h.calls.filter((call) => call.name === 'reportInteraction').map((call) => call.args[0]);
  assert.deepEqual(reported(), ['rapid'], 'burst must not also report double');
  h.advance(5000);
  assert.deepEqual(reported(), ['rapid'], 'the cancelled settle timer must stay cancelled');
});

test('clicks swallowed by the debounce window do not drift the counter', () => {
  const h = createRendererHarness();
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()');
  h.advance(100);
  h.run('registerInteractionClick()'); // rapid -> 900ms lock (t=1200 -> 2100)
  h.advance(200);
  h.run('registerInteractionClick()'); // swallowed, must reset the baseline
  h.advance(800);                      // t=2200, past the lock
  h.run('registerInteractionClick()'); // first click after the lock
  h.advance(400);                      // settle
  const reported = () => h.calls.filter((call) => call.name === 'reportInteraction').map((call) => call.args[0]);
  assert.deepEqual(reported(), ['rapid', 'single'], 'post-debounce click is a single, not a double');
});

test('a stale temporary-expression timer cannot overwrite a newer decision', () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('worried');
  h.run("settleExpression('surprised', 1300)");
  assert.equal(h.run('activeExpression'), 'surprised');
  // A newer, longer-lived decision supersedes the pending restore.
  h.run("settleExpression('soft_smile', 3000)");
  h.advance(1400); // the first timer would have fired here
  assert.equal(h.run('activeExpression'), 'soft_smile', 'stale timer must not fire');
  h.advance(2000);
  assert.equal(h.run('activeExpression'), 'worried');
});

test('handing over to the next line does not flash the previous expression', async () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('soft_smile');
  await speak(h, 1, 'annoyed');
  h.applyFrame();
  assert.equal(h.parameter('ParamExpression'), 6, 'line 1 uses the annoyed expression');

  // Second line takes over while the first is still playing.
  h.clearParameterLog();
  await speak(h, 2, 'surprised');
  h.applyFrame();
  const applied = h.parameterLog.filter((entry) => entry.id === 'ParamExpression').map((entry) => entry.value);
  assert.deepEqual(
    applied,
    [4],
    `after the handover only the new line may be applied, got ${JSON.stringify(h.parameterLog)}`
  );

  h.audios[1].emit('ended');
  assert.equal(h.run('activeExpression'), 'soft_smile', 'manual selection survives the handover');
  h.advance(5000);
  assert.equal(h.run('activeExpression'), 'soft_smile', 'and it is not overwritten later');
});
