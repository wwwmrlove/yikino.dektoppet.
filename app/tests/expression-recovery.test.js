'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness } = require('./helpers/renderer-harness');

function speak(h, token, expression = 'annoyed') {
  h.context.testDialogue = { speechToken: token, expression, file: 'test.wav' };
  return h.run('speakDialogue(testDialogue)');
}

test('manual selection during speech survives completion and subsequent speech', async () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('soft_smile');
  await speak(h, 1);
  h.callbacks.onExpression('worried');
  assert.equal(h.run('activeExpression'), 'worried');
  h.audios[0].emit('ended');
  assert.equal(h.run('activeExpression'), 'worried');
  assert.equal(h.run('persistentExpression'), 'worried');
  await speak(h, 2, 'surprised');
  h.audios[1].emit('ended');
  assert.equal(h.run('activeExpression'), 'worried');
});

test('temporary click expression returns to the latest persistent selection', () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('worried');
  h.run('registerInteractionClick()');
  assert.equal(h.run('activeExpression'), 'soft_smile');
  h.advance(901);
  assert.equal(h.run('activeExpression'), 'worried');
  h.run('registerInteractionClick()');
  h.callbacks.onExpression('closed');
  h.advance(2000);
  assert.equal(h.run('activeExpression'), 'closed');
});

test('a temporary expression expiring while speaking cannot replace the persistent choice', async () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('worried');
  h.run("setExpression('surprised', 900)");
  await speak(h, 1);
  h.advance(1000);
  h.audios[0].emit('ended');
  assert.equal(h.run('activeExpression'), 'worried');
});

test('an unexpired temporary expression keeps its remaining time after speech', async () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('closed');
  h.run("setExpression('surprised', 1300)");
  await speak(h, 1);
  h.advance(400);
  h.audios[0].emit('ended');
  assert.equal(h.run('activeExpression'), 'surprised');
  h.advance(899);
  assert.equal(h.run('activeExpression'), 'surprised');
  h.advance(2);
  assert.equal(h.run('activeExpression'), 'closed');
});

test('a manual default selection during speech clears the old temporary restore target', async () => {
  const h = createRendererHarness();
  h.callbacks.onExpression('worried');
  h.run("setExpression('surprised', 1300)");
  await speak(h, 1);
  h.callbacks.onExpression('default');
  h.audios[0].emit('ended');
  h.advance(2000);
  assert.equal(h.run('activeExpression'), 'default');
});
