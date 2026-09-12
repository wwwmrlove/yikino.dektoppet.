'use strict';

// The model uses discrete mouth artwork with opacity keyframes. An arbitrary
// audio amplitude is not a safe ParamMouthOpenY value for the selected artwork.
(function exposeMouthController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YukinoMouth = api;
})(globalThis, () => {
  const PARTS = Object.freeze([
    'MOUTH_00_DEFAULT_EXACT', 'MOUTH_01_CLOSED_NEUTRAL', 'MOUTH_02_SMILE',
    'MOUTH_03_TROUBLED_FLAT', 'MOUTH_04_SMALL_OPEN', 'MOUTH_05_MEDIUM_OPEN',
    'MOUTH_06_WIDE_OPEN', 'MOUTH_07_ROUNDED_VOWEL'
  ]);
  const pose = (part, form, open) => Object.freeze({ part, form, open });
  const POSES = Object.freeze([
    pose(PARTS[0], 0, 0), pose(PARTS[1], -0.5, 0), pose(PARTS[2], 1, 0),
    pose(PARTS[3], -1, 0), pose(PARTS[4], 0, 0.3), pose(PARTS[5], 0, 0.6),
    pose(PARTS[6], 0, 1), pose(PARTS[7], 0.5, 0)
  ]);
  const IDLE_POSE = Object.freeze({
    default: 0, half_blink: 0, closed: 1, soft_smile: 2, annoyed: 3,
    worried: 3, surprised: 5, speak_a: 5, speak_o: 7
  });
  const SPEECH_THRESHOLDS = Object.freeze([0.08, 0.3, 0.62]);

  function getPose(expression, speaking, amplitude) {
    if (!speaking) return POSES[IDLE_POSE[expression] ?? 0];
    const level = Number.isFinite(amplitude) ? Math.max(0, Math.min(1, amplitude)) : 0;
    if (level >= SPEECH_THRESHOLDS[2]) return POSES[6];
    if (level >= SPEECH_THRESHOLDS[1]) return POSES[5];
    if (level >= SPEECH_THRESHOLDS[0]) return POSES[4];
    return POSES[1];
  }

  function create(core, getId, onViolation = console.error) {
    const parts = PARTS.map((id) => ({ id, key: getId(id), index: core.getPartIndex(getId(id)) }));
    const formId = getId('ParamMouthForm');
    const openId = getId('ParamMouthOpenY');
    const mouthDrawables = [];
    for (let index = 0; index < core.getDrawableCount(); index += 1) {
      const parent = core.getDrawableParentPartIndex(index);
      const part = parts.find((candidate) => candidate.index === parent);
      if (part) mouthDrawables.push({ index, part: part.id });
    }
    let expected = POSES[0];
    let warningShown = false;

    function apply(expression, speaking, amplitude) {
      expected = getPose(expression, speaking, amplitude);
      core.setParameterValueById(formId, expected.form);
      core.setParameterValueById(openId, expected.open);
      for (const part of parts) core.setPartOpacityById(part.key, part.id === expected.part ? 1 : 0);
      return expected;
    }

    function inspect() {
      const visibleParts = parts.filter((part) => core.getPartOpacityById(part.key) > 0.01)
        .map((part) => part.id);
      const visibleDrawables = mouthDrawables.map((drawable) => ({
        part: drawable.part, opacity: core.getDrawableOpacity(drawable.index)
      })).filter((drawable) => drawable.opacity > 0.01);
      const valid = visibleParts.length === 1 && visibleParts[0] === expected.part
        && visibleDrawables.length === 1 && visibleDrawables[0].part === expected.part
        && visibleDrawables[0].opacity >= 0.99;
      return { valid, expected: expected.part, visibleParts, visibleDrawables };
    }

    // This engine exposes only beforeModelUpdate. Inspect after the native Core
    // calculation, when parameter-dependent Drawable opacity has been resolved.
    const update = core.update;
    core.update = function updateWithMouthAudit(...args) {
      const result = update.apply(this, args);
      const state = inspect();
      if (!state.valid && !warningShown) {
        warningShown = true;
        onViolation('Final mouth visibility invariant failed:', state);
      }
      return result;
    };
    return { apply, inspect };
  }

  return { PARTS, SPEECH_THRESHOLDS, getPose, create };
});
