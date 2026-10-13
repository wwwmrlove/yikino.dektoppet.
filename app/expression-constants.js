'use strict';

// Single source of truth for the expression names the app may select.
//
// Before this module the whitelist existed in three places at once:
//   1. the pet menu / main-process validation (5 names)
//   2. renderer.js EXPRESSION_PARAMETERS       (9 names)
//   3. mouth-controller.js IDLE_POSE           (9 names)
// They drifted, which made `closed` and `half_blink` selectable through the
// IPC layer but absent from the menu, so either could become the persistent
// expression while being unreachable from the UI.
//
// Every expression here must have a pose in mouth-controller.js IDLE_POSE and
// an entry in renderer.js EXPRESSION_PARAMETERS. app/tests/expression-contract
// .test.js enforces that.

// Menu order, and the order the control panel renders.
const SELECTABLE_EXPRESSIONS = Object.freeze([
  Object.freeze({ name: 'default', label: '默认' }),
  Object.freeze({ name: 'half_blink', label: '半闭眼' }),
  Object.freeze({ name: 'closed', label: '闭眼' }),
  Object.freeze({ name: 'soft_smile', label: '微笑' }),
  Object.freeze({ name: 'annoyed', label: '不高兴' }),
  Object.freeze({ name: 'surprised', label: '惊讶' }),
  Object.freeze({ name: 'worried', label: '担心' })
]);

const EXPRESSION_NAMES = Object.freeze(SELECTABLE_EXPRESSIONS.map((item) => item.name));

const EXPRESSION_NAME_SET = Object.freeze(new Set(EXPRESSION_NAMES));

// Expressions the renderer may apply internally (a dialogue may reference one
// of these without it being user-selectable). Keep in sync with
// EXPRESSION_PARAMETERS in renderer.js.
const INTERNAL_EXPRESSIONS = Object.freeze(['speak_a', 'speak_o']);

const ALL_EXPRESSION_NAMES = Object.freeze([...EXPRESSION_NAMES, ...INTERNAL_EXPRESSIONS]);

function isSelectableExpression(name) {
  return typeof name === 'string' && EXPRESSION_NAME_SET.has(name);
}

module.exports = {
  SELECTABLE_EXPRESSIONS,
  EXPRESSION_NAMES,
  INTERNAL_EXPRESSIONS,
  ALL_EXPRESSION_NAMES,
  isSelectableExpression
};
