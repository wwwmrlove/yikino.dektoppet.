'use strict';

const canvas = document.getElementById('pet-canvas');
const status = document.getElementById('status');
const hint = document.getElementById('hint');

window.addEventListener('error', (event) => {
  console.error('Window error:', event.error?.stack || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason?.stack || event.reason);
});

let model = null;
let baseFitScale = 1;
let userScale = 1;
let dragState = null;
let resetExpressionTimer = null;
let activeExpression = 'default';
let activeExpressionExpiresAt = 0;
let hintTimer = null;
let pointerTarget = { x: 0, y: 0 };
let app = null;
let hitMask = null;
let hitMaskTimer = null;
let pointerOverPet = false;
let hitMaskReadyLogged = false;
let nextBlinkAt = 0;
let blinkStartedAt = null;
let audioContext = null;
let audioAnalyser = null;
let activeAudio = null;
let activeAudioSource = null;
let speechSamples = null;
let speechMouthLevel = 0;
let isSpeaking = false;
let expressionBeforeSpeech = 'default';
let expressionBeforeSpeechExpiresAt = 0;
let speechToken = 0;
let interactionClicks = [];
let interactionClickTimer = null;
let rapidClickLockedUntil = 0;
let mouthInvariantWarningShown = false;

const HIT_MASK_RESOLUTION = 0.5;
const HIT_MASK_REFRESH_MS = 180;
const HIT_ALPHA_THRESHOLD = 18;
const BLINK_INTERVAL_MIN_MS = 3000;
const BLINK_INTERVAL_MAX_MS = 6000;
const BLINK_CLOSE_MS = 85;
const BLINK_HOLD_MS = 45;
const BLINK_OPEN_MS = 125;
const INTERACTION_SETTLE_MS = 360;
const RAPID_CLICK_THRESHOLD = 3;
const RAPID_CLICK_LOCK_MS = 900;

const EXPRESSION_PARAMETERS = Object.freeze({
  default:     { ParamExpression: 0, ParamMouthForm: 0,    ParamMouthOpenY: 0,   ParamEyeLOpen: 1,   ParamEyeROpen: 1 },
  half_blink:  { ParamExpression: 0, ParamMouthForm: 0,    ParamMouthOpenY: 0,   ParamEyeLOpen: 0.5, ParamEyeROpen: 0.5 },
  closed:      { ParamExpression: 0, ParamMouthForm: -0.5, ParamMouthOpenY: 0,   ParamEyeLOpen: 0,   ParamEyeROpen: 0 },
  soft_smile:  { ParamExpression: 3, ParamMouthForm: 1,    ParamMouthOpenY: 0,   ParamEyeLOpen: 1,   ParamEyeROpen: 1 },
  annoyed:     { ParamExpression: 6, ParamMouthForm: -1,   ParamMouthOpenY: 0,   ParamEyeLOpen: 1,   ParamEyeROpen: 1 },
  // The surprised idle pose uses the medium-open artwork. Keeping this at 1
  // selects the wide-open drawable range and makes the medium mouth disappear.
  surprised:   { ParamExpression: 4, ParamMouthForm: 0,    ParamMouthOpenY: 0.6, ParamEyeLOpen: 1.2, ParamEyeROpen: 1.2 },
  worried:     { ParamExpression: 5, ParamMouthForm: 0,    ParamMouthOpenY: 0,   ParamEyeLOpen: 1.2, ParamEyeROpen: 1.2 },
  speak_a:     { ParamExpression: 1, ParamMouthForm: 0,    ParamMouthOpenY: 0.6, ParamEyeLOpen: 1.2, ParamEyeROpen: 1.2 },
  speak_o:     { ParamExpression: 1, ParamMouthForm: 0.5,  ParamMouthOpenY: 0,   ParamEyeLOpen: 1.2, ParamEyeROpen: 1.2 }
});

const MOUTH_PARTS = Object.freeze([
  'MOUTH_00_DEFAULT_EXACT',
  'MOUTH_01_CLOSED_NEUTRAL',
  'MOUTH_02_SMILE',
  'MOUTH_03_TROUBLED_FLAT',
  'MOUTH_04_SMALL_OPEN',
  'MOUTH_05_MEDIUM_OPEN',
  'MOUTH_06_WIDE_OPEN',
  'MOUTH_07_ROUNDED_VOWEL'
]);

const EXPRESSION_MOUTH_PART = Object.freeze({
  default: 'MOUTH_00_DEFAULT_EXACT',
  half_blink: 'MOUTH_00_DEFAULT_EXACT',
  closed: 'MOUTH_01_CLOSED_NEUTRAL',
  soft_smile: 'MOUTH_02_SMILE',
  annoyed: 'MOUTH_03_TROUBLED_FLAT',
  worried: 'MOUTH_03_TROUBLED_FLAT',
  // Wide-open is reserved exclusively for live speech amplitude. Even the
  // surprised idle expression must stop at the medium-open artwork.
  surprised: 'MOUTH_05_MEDIUM_OPEN',
  speak_a: 'MOUTH_05_MEDIUM_OPEN',
  speak_o: 'MOUTH_07_ROUNDED_VOWEL'
});

function showHint(message, duration = 1500) {
  hint.textContent = message;
  hint.classList.add('show');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.remove('show'), duration);
}

function applyModelLayout() {
  if (!app || !model) return;
  const bounds = model.getLocalBounds();
  const availableHeight = app.screen.height * 0.965;
  const availableWidth = app.screen.width * 0.94;
  baseFitScale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  const scale = baseFitScale * userScale;
  model.scale.set(scale);
  model.x = (app.screen.width - bounds.width * scale) / 2 - bounds.x * scale;
  model.y = app.screen.height - bounds.height * scale - bounds.y * scale;
  window.desktopPet.reportLayout({
    anchorX: model.x + (bounds.x + bounds.width / 2) * scale,
    anchorY: model.y + bounds.y * scale,
    visibleWidth: bounds.width * scale,
    visibleHeight: bounds.height * scale,
    modelScale: userScale
  });
  refreshHitMaskSoon();
}

function refreshHitMask() {
  if (!app || !model) return;
  try {
    hitMask = app.renderer.extract.pixels({
      target: app.stage,
      frame: new PIXI.Rectangle(0, 0, app.screen.width, app.screen.height),
      resolution: HIT_MASK_RESOLUTION,
      clearColor: '#00000000'
    });
    if (!hitMaskReadyLogged) {
      hitMaskReadyLogged = true;
      console.info(
        `Pointer hit mask ready: ${hitMask.width}x${hitMask.height}; bodyHit=${isVisiblePetPixel(window.innerWidth * 0.5, window.innerHeight * 0.43)}`
      );
    }
  } catch (error) {
    console.warn('Unable to refresh pointer hit mask:', error);
  }
}

function refreshHitMaskSoon() {
  window.clearTimeout(hitMaskTimer);
  hitMaskTimer = window.setTimeout(refreshHitMask, 0);
}

function isVisiblePetPixel(clientX, clientY) {
  if (dragState) return true;
  if (!hitMask || !window.innerWidth || !window.innerHeight) return false;

  const centerX = Math.floor(clientX / window.innerWidth * hitMask.width);
  const centerY = Math.floor(clientY / window.innerHeight * hitMask.height);
  if (centerX < 0 || centerY < 0 || centerX >= hitMask.width || centerY >= hitMask.height) return false;

  // One mask pixel is roughly two screen pixels. The small tolerance makes thin hair strands easy to grab.
  for (let y = Math.max(0, centerY - 1); y <= Math.min(hitMask.height - 1, centerY + 1); y += 1) {
    for (let x = Math.max(0, centerX - 1); x <= Math.min(hitMask.width - 1, centerX + 1); x += 1) {
      if (hitMask.pixels[(y * hitMask.width + x) * 4 + 3] >= HIT_ALPHA_THRESHOLD) return true;
    }
  }
  return false;
}

function reportPointerHit(isOverPet) {
  const next = Boolean(isOverPet || dragState);
  if (pointerOverPet === next) return;
  pointerOverPet = next;
  window.desktopPet.setPointerOver(next);
}

function updatePointerFromMouseEvent(event) {
  pointerTarget.x = Math.min(1, Math.max(-1, (event.clientX / window.innerWidth - 0.5) * 2));
  pointerTarget.y = Math.min(1, Math.max(-1, (0.5 - event.clientY / window.innerHeight) * 2));
  reportPointerHit(isVisiblePetPixel(event.clientX, event.clientY));
}

function setUserScale(next, announce = true) {
  userScale = Math.min(1.35, Math.max(0.62, Number(next.toFixed(2))));
  applyModelLayout();
  window.desktopPet.saveScale(userScale);
  if (announce) showHint(`大小 ${Math.round(userScale * 100)}%`);
}

function scheduleNextBlink(now) {
  const interval = BLINK_INTERVAL_MIN_MS
    + Math.random() * (BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS);
  nextBlinkAt = now + interval;
}

function smoothStep01(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function getAutoBlinkFactor(now) {
  if (!nextBlinkAt) scheduleNextBlink(now);

  if (blinkStartedAt === null) {
    if (now < nextBlinkAt) return 1;
    blinkStartedAt = now;
  }

  const elapsed = now - blinkStartedAt;
  if (elapsed < BLINK_CLOSE_MS) {
    return 1 - smoothStep01(elapsed / BLINK_CLOSE_MS);
  }

  const openingAt = BLINK_CLOSE_MS + BLINK_HOLD_MS;
  if (elapsed < openingAt) return 0;

  const finishedAt = openingAt + BLINK_OPEN_MS;
  if (elapsed < finishedAt) {
    return smoothStep01((elapsed - openingAt) / BLINK_OPEN_MS);
  }

  blinkStartedAt = null;
  scheduleNextBlink(now);
  return 1;
}

function applyActiveExpression() {
  const internalModel = model?.internalModel;
  const core = internalModel?.coreModel;
  const parameters = EXPRESSION_PARAMETERS[activeExpression];
  if (!core || !parameters) return;
  for (const [id, value] of Object.entries(parameters)) {
    if (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen') continue;
    if (isSpeaking && id === 'ParamMouthOpenY') continue;
    core.setParameterValueById(internalModel.getIdSafe(id), value);
  }

  // Idle is a continuously running motion, so the Cubism runtime suppresses
  // its built-in blink controller. Apply a separate blink factor after the
  // active expression so blinking works without replacing expression eye sizes.
  const blinkFactor = getAutoBlinkFactor(performance.now());
  core.setParameterValueById(
    internalModel.getIdSafe('ParamEyeLOpen'),
    parameters.ParamEyeLOpen * blinkFactor
  );
  core.setParameterValueById(
    internalModel.getIdSafe('ParamEyeROpen'),
    parameters.ParamEyeROpen * blinkFactor
  );

  // Every mouth variant is a separate Part in this model. Enforce a strict
  // one-part-only invariant every frame; controlling only the open variants
  // leaves a closed/smiling layer underneath and creates doubled mouths.
  let visibleMouthPart = EXPRESSION_MOUTH_PART[activeExpression]
    || 'MOUTH_00_DEFAULT_EXACT';
  if (isSpeaking) {
    core.setParameterValueById(internalModel.getIdSafe('ParamMouthOpenY'), speechMouthLevel);
    if (speechMouthLevel >= 0.62) visibleMouthPart = 'MOUTH_06_WIDE_OPEN';
    else if (speechMouthLevel >= 0.3) visibleMouthPart = 'MOUTH_05_MEDIUM_OPEN';
    else if (speechMouthLevel >= 0.08) visibleMouthPart = 'MOUTH_04_SMALL_OPEN';
    else visibleMouthPart = 'MOUTH_01_CLOSED_NEUTRAL';
  }
  for (const partId of MOUTH_PARTS) {
    core.setPartOpacityById(internalModel.getIdSafe(partId), partId === visibleMouthPart ? 1 : 0);
  }
  if (!mouthInvariantWarningShown && typeof core.getPartOpacityById === 'function') {
    const visibleParts = MOUTH_PARTS.filter((partId) => (
      core.getPartOpacityById(internalModel.getIdSafe(partId)) > 0.01
    ));
    if (visibleParts.length !== 1 || visibleParts[0] !== visibleMouthPart) {
      mouthInvariantWarningShown = true;
      console.error('Mouth-part exclusivity invariant failed:', {
        expected: visibleMouthPart,
        visible: visibleParts
      });
    }
  }
}

function updateSpeechMouth() {
  if (!isSpeaking || !audioAnalyser || !speechSamples) {
    speechMouthLevel *= 0.62;
    if (speechMouthLevel < 0.01) speechMouthLevel = 0;
    return;
  }

  audioAnalyser.getFloatTimeDomainData(speechSamples);
  let sumSquares = 0;
  for (const sample of speechSamples) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / speechSamples.length);
  const target = Math.min(1, Math.max(0, (rms - 0.012) * 9));
  const smoothing = target > speechMouthLevel ? 0.58 : 0.24;
  speechMouthLevel += (target - speechMouthLevel) * smoothing;
}

function finishSpeech(token, error = null) {
  if (token !== speechToken) return;
  isSpeaking = false;
  speechMouthLevel = 0;
  if (activeAudioSource) {
    try { activeAudioSource.disconnect(); } catch { /* already disconnected */ }
  }
  activeAudioSource = null;
  activeAudio = null;
  audioAnalyser = null;
  speechSamples = null;
  const remainingExpressionMs = expressionBeforeSpeechExpiresAt > 0
    ? expressionBeforeSpeechExpiresAt - performance.now()
    : 0;
  if (expressionBeforeSpeechExpiresAt === 0 || remainingExpressionMs > 0) {
    setExpression(expressionBeforeSpeech || 'default', Math.max(0, remainingExpressionMs));
  } else {
    setExpression('default');
  }
  expressionBeforeSpeech = 'default';
  expressionBeforeSpeechExpiresAt = 0;
  window.desktopPet.speechEnded(token);
  if (error) {
    console.error('Unable to play Yukino voice:', error);
    showHint('语音播放失败，请先生成语音素材', 2600);
  }
}

function disposeAudio(audio, source) {
  if (audio) {
    try { audio.pause(); } catch { /* audio may not have started */ }
    audio.removeAttribute('src');
    try { audio.load(); } catch { /* ignore media teardown failures */ }
  }
  if (source) {
    try { source.disconnect(); } catch { /* already disconnected */ }
  }
}

async function speakDialogue(dialogue) {
  if (!dialogue?.file) return;
  const token = ++speechToken;
  if (activeAudio) {
    disposeAudio(activeAudio, activeAudioSource);
  }
  activeAudio = null;
  activeAudioSource = null;
  audioAnalyser = null;
  speechSamples = null;

  if (!isSpeaking) {
    expressionBeforeSpeech = activeExpression;
    expressionBeforeSpeechExpiresAt = activeExpressionExpiresAt;
  }
  isSpeaking = true;
  speechMouthLevel = 0;
  setExpression(dialogue.expression || 'default');

  try {
    audioContext ||= new AudioContext();
    await audioContext.resume();
    if (token !== speechToken) return;
    const audioUrl = new URL(`../assets/voice/${dialogue.file}`, window.location.href).href;
    const audio = new Audio(audioUrl);
    audio.preload = 'auto';
    const source = audioContext.createMediaElementSource(audio);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.42;
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    if (token !== speechToken) {
      disposeAudio(audio, source);
      return;
    }

    activeAudio = audio;
    activeAudioSource = source;
    audioAnalyser = analyser;
    speechSamples = new Float32Array(analyser.fftSize);
    audio.addEventListener('ended', () => finishSpeech(token), { once: true });
    audio.addEventListener('error', () => finishSpeech(token, audio.error || new Error('Audio load failed')), { once: true });
    await audio.play();
    if (token !== speechToken) {
      disposeAudio(audio, source);
      return;
    }
    window.desktopPet.speechStarted({
      token,
      text: dialogue.translation || dialogue.label || '',
      durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
      dialogueId: dialogue.id || '',
      triggerName: dialogue.triggerName || 'manual'
    });
  } catch (error) {
    if (token === speechToken) finishSpeech(token, error);
  }
}

function reportClassifiedInteraction(type) {
  console.info(`Interaction classified: ${type}`);
  window.desktopPet.reportInteraction(type);
}

function registerInteractionClick() {
  const now = performance.now();
  if (now < rapidClickLockedUntil) {
    if (!isSpeaking) setExpression('annoyed', 1500);
    return;
  }

  interactionClicks.push(now);
  window.clearTimeout(interactionClickTimer);
  interactionClickTimer = null;

  if (interactionClicks.length >= RAPID_CLICK_THRESHOLD) {
    interactionClicks = [];
    rapidClickLockedUntil = now + RAPID_CLICK_LOCK_MS;
    if (!isSpeaking) setExpression('annoyed', 1800);
    reportClassifiedInteraction('rapid');
    return;
  }

  if (!isSpeaking) {
    setExpression(interactionClicks.length === 2 ? 'surprised' : 'soft_smile',
      interactionClicks.length === 2 ? 1300 : 900);
  }

  interactionClickTimer = window.setTimeout(() => {
    const type = interactionClicks.length >= 2 ? 'double' : 'single';
    interactionClicks = [];
    interactionClickTimer = null;
    reportClassifiedInteraction(type);
  }, INTERACTION_SETTLE_MS);
}

function setExpression(name, restoreAfter = 0) {
  if (!model) return;
  if (!EXPRESSION_PARAMETERS[name]) return;
  window.clearTimeout(resetExpressionTimer);
  resetExpressionTimer = null;
  activeExpression = name;
  activeExpressionExpiresAt = restoreAfter > 0 && name !== 'default'
    ? performance.now() + restoreAfter
    : 0;
  if (restoreAfter > 0 && name !== 'default') {
    resetExpressionTimer = window.setTimeout(() => setExpression('default'), restoreAfter);
  }
}

function setParameter(id, value) {
  const internalModel = model?.internalModel;
  const core = internalModel?.coreModel;
  if (!core) return;
  try {
    core.setParameterValueById(internalModel.getIdSafe(id), value);
  } catch {
    // The source model may not use every optional tracking parameter.
  }
}

function updatePointerTracking() {
  if (!model || dragState) return;
  setParameter('ParamAngleX', pointerTarget.x * 7);
  setParameter('ParamAngleY', pointerTarget.y * 4);
  setParameter('ParamEyeBallX', pointerTarget.x);
  setParameter('ParamEyeBallY', pointerTarget.y);
}

async function loadModel() {
  try {
    const state = await window.desktopPet.getState();
    userScale = Number.isFinite(state.modelScale) ? state.modelScale : 1;
    const modelUrl = new URL('../assets/model/yukino-live2d-final.model3.json', window.location.href).href;
    model = await PIXI.live2d.Live2DModel.from(modelUrl, {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: true,
      textureOptions: { lod: 'single-auto' }
    });
    model.anchor.set(0, 0);
    model.eventMode = 'static';
    app.stage.addChild(model);
    model.internalModel.on('beforeModelUpdate', applyActiveExpression);
    applyModelLayout();
    app.ticker.add(updateSpeechMouth);
    app.ticker.add(updatePointerTracking);
    app.ticker.add(() => {
      const now = performance.now();
      if (!hitMask || now - (hitMask.updatedAt || 0) >= HIT_MASK_REFRESH_MS) {
        refreshHitMask();
        if (hitMask) hitMask.updatedAt = now;
      }
    });
    setExpression('default');
    await model.motion('Idle', 0);
    status.classList.add('hidden');
    window.setTimeout(() => status.remove(), 250);
    showHint('拖动移动 · 滚轮缩放 · 右键菜单', 2600);
  } catch (error) {
    console.error(error);
    status.textContent = `模型载入失败：${error.message || error}`;
    status.classList.add('error');
  }
}

async function boot() {
  try {
    PIXI.extensions.add(PIXI.live2d.Live2DPlugin);
    PIXI.live2d.configureCubismSDK({ memorySizeMB: 32 });
    app = new PIXI.Application();
    await app.init({
      canvas,
      resizeTo: window,
      preference: 'webgl',
      antialias: true,
      autoStart: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      backgroundAlpha: 0
    });
    await loadModel();
  } catch (error) {
    console.error(error);
    status.textContent = `渲染器启动失败：${error.message || error}`;
    status.classList.add('error');
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !isVisiblePetPixel(event.clientX, event.clientY)) return;
  dragState = {
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startWindowX: window.screenX,
    startWindowY: window.screenY,
    moved: false
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
  reportPointerHit(true);
});

canvas.addEventListener('pointermove', (event) => {
  updatePointerFromMouseEvent(event);
  if (!dragState) return;
  const dx = event.screenX - dragState.startScreenX;
  const dy = event.screenY - dragState.startScreenY;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
  window.desktopPet.moveTo(dragState.startWindowX + dx, dragState.startWindowY + dy);
});

canvas.addEventListener('pointerup', (event) => {
  if (!dragState) return;
  const wasMoved = dragState.moved;
  dragState = null;
  canvas.classList.remove('dragging');
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  reportPointerHit(isVisiblePetPixel(event.clientX, event.clientY));
  if (!wasMoved) {
    registerInteractionClick();
  }
});

canvas.addEventListener('pointercancel', (event) => {
  dragState = null;
  canvas.classList.remove('dragging');
  reportPointerHit(isVisiblePetPixel(event.clientX, event.clientY));
});

canvas.addEventListener('pointerleave', () => {
  if (!dragState) reportPointerHit(false);
});

// Electron forwards regular mousemove events while the window is click-through.
// This listener is what lets a transparent window become interactive again over visible pixels.
window.addEventListener('mousemove', updatePointerFromMouseEvent);

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!isVisiblePetPixel(event.clientX, event.clientY)) return;
  window.desktopPet.showMenu();
});

canvas.addEventListener('wheel', (event) => {
  if (!isVisiblePetPixel(event.clientX, event.clientY)) return;
  event.preventDefault();
  setUserScale(userScale + (event.deltaY < 0 ? 0.06 : -0.06));
}, { passive: false });

window.addEventListener('resize', () => {
  applyModelLayout();
  refreshHitMaskSoon();
});
window.desktopPet.onExpression((name) => setExpression(name));
window.desktopPet.onSpeak((dialogue) => speakDialogue(dialogue));
window.desktopPet.onScaleStep((amount) => setUserScale(userScale + amount));
window.desktopPet.onScaleReset(() => setUserScale(1));
window.desktopPet.onPointerPosition((point) => {
  if (!point?.inside) {
    if (!dragState) reportPointerHit(false);
    return;
  }
  updatePointerFromMouseEvent({ clientX: point.x, clientY: point.y });
});
window.desktopPet.onClickThrough((enabled) => {
  if (!enabled) showHint('鼠标穿透已关闭');
});

boot();
