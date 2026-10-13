'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, powerMonitor, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createTriggerEngine } = require('./trigger-engine');
const { createWeatherService } = require('./weather-service');
const { createBehaviorSettingsService } = require('./behavior-settings');
const { calculateSubtitlePlacement } = require('./subtitle-placement');
const { createRendererRecovery } = require('./renderer-recovery');
const { createJsonStore } = require('./json-store');
const { calculateMenuBounds } = require('./menu-placement');
const { calculatePetBounds } = require('./pet-placement');
const { installSafeLogging } = require('./safe-logging');
const { SELECTABLE_EXPRESSIONS, isSelectableExpression } = require('./expression-constants');
const jsonStore = createJsonStore(fs);

// An isolated development profile keeps recovery tests away from personal settings.
if (!app.isPackaged && process.env.YUKINO_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.YUKINO_TEST_USER_DATA));
}
installSafeLogging({logFile: path.join(app.getPath('userData'), 'logs', 'main.log')});
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

const BASE_SUBTITLE_WIDTH = 352;
const BASE_SUBTITLE_HEIGHT = 198;
const PET_MENU_WIDTH = 334;
const PET_MENU_HEIGHT = 636;
const STATE_FILE = 'window-state.json';
const DIALOGUES_FILE = path.join(__dirname, 'assets', 'voice', 'dialogues.json');

let petWindow = null;
let subtitleWindow = null;
let subtitleReady = false;
let pendingSubtitle = null;
let activeSubtitleToken = 0;
let triggerEngine = null;
let weatherService = null;
let weatherSettingsWindow = null;
let behaviorSettingsService = null;
let behaviorSettingsWindow = null;
let petMenuWindow = null;
let petMenuReady = false;
let petMenuPositionSaveTimer = null;
let petMenuPositionGuardTimer = null;
let petMenuPositioning = false;
let alwaysOnTop = true;
let clickThrough = false;
let pointerOverPet = false;
let ignoringMouseEvents = null;
let pointerPollTimer = null;
let savedState = {};
let petModelLayout = null;
let rendererRecovery = null;
let tray = null;
let stateSaveTimer = null;
let stateDirty = false;
let quitting = false;

const statePath = () => path.join(app.getPath('userData'), STATE_FILE);

function readState() {
  const state = jsonStore.read(statePath(), {});
  return {
    ...state,
    modelScale: Number.isFinite(state.modelScale) ? Math.min(1.35, Math.max(0.62, state.modelScale)) : 1
  };
}

function flushState() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  if (!stateDirty) return;
  try {
    jsonStore.write(statePath(), savedState);
    stateDirty = false;
  } catch (error) { console.error('Unable to save desktop-pet state:', error); }
}

function writeState(patch, immediate = false) {
  savedState = { ...savedState, ...patch };
  stateDirty = true;
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  if (immediate) flushState();
  else stateSaveTimer = setTimeout(flushState, 300);
}

function clampToWorkArea(x, y) {
  const display = screen.getDisplayNearestPoint({ x, y });
  return calculatePetBounds({ x, y }, display.workArea, savedState.modelScale);
}

function defaultBounds() {
  return calculatePetBounds(null, screen.getPrimaryDisplay().workArea, savedState.modelScale);
}

function setPetBounds(bounds) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const previous = petWindow.getBounds();
  if (previous.width !== bounds.width || previous.height !== bounds.height) {
    // Fixed-size windows otherwise refuse the smaller bounds after a display
    // change. Restore the constraints after fitting the target work area.
    petWindow.setMinimumSize(1, 1);
    petWindow.setMaximumSize(0, 0);
    petWindow.setBounds(bounds, false);
    petWindow.setMinimumSize(bounds.width, bounds.height);
    petWindow.setMaximumSize(bounds.width, bounds.height);
  } else {
    petWindow.setPosition(bounds.x, bounds.y, false);
  }
}

function applyMouseEventMode() {
  if (petWindow && !petWindow.isDestroyed()) {
    const shouldIgnore = clickThrough || !pointerOverPet;
    if (ignoringMouseEvents !== shouldIgnore) {
      ignoringMouseEvents = shouldIgnore;
      petWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
    }
  }
}

function setClickThrough(enabled) {
  clickThrough = Boolean(enabled);
  applyMouseEventMode();
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:click-through', clickThrough);
  }
  updateTrayMenu();
}

function setAlwaysOnTop(enabled) {
  alwaysOnTop = Boolean(enabled);
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  }
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  }
  if (petMenuWindow && !petMenuWindow.isDestroyed()) {
    petMenuWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  }
  writeState({ alwaysOnTop });
  updateTrayMenu();
}

function sendExpression(name) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:expression', name);
  }
}

function readDialogues() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DIALOGUES_FILE, 'utf8'));
    return Array.isArray(parsed.dialogues) ? parsed.dialogues : [];
  } catch (error) {
    console.error('Unable to load voice dialogues:', error);
    return [];
  }
}

function deliverSpeech(dialogue) {
  if (petWindow && !petWindow.isDestroyed() && dialogue) {
    petWindow.webContents.send('pet:speak', dialogue);
    return true;
  }
  return false;
}

function clearSubtitle() {
  pendingSubtitle = null;
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    if (subtitleReady) subtitleWindow.webContents.send('subtitle:hide', activeSubtitleToken);
    subtitleWindow.hide();
  }
  activeSubtitleToken = 0;
}

function cancelPetSpeech(token, reason) {
  hideSubtitle(token);
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) {
    throw new Error('Pet renderer is unavailable');
  }
  try { petWindow.webContents.send('pet:speech-cancelled', { token, reason }); }
  catch (error) { rendererRecovery?.failed(error.message); throw error; }
}

function restorePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  setClickThrough(false);
  const bounds = defaultBounds();
  setPetBounds(bounds);
  petWindow.showInactive();
  if (rendererRecovery?.getState() === 'failed') rendererRecovery.retry();
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '找回雪乃 / 关闭鼠标穿透', click: restorePetWindow },
    { label: '打开控制面板', click: showPetMenu },
    { label: '重新载入角色', click: () => rendererRecovery?.retry() },
    { type: 'separator' },
    { label: '始终置顶', type: 'checkbox', checked: alwaysOnTop, click: item => setAlwaysOnTop(item.checked) },
    { label: '鼠标穿透', type: 'checkbox', checked: clickThrough, click: item => setClickThrough(item.checked) },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() }
  ]));
}

function createTray() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (Math.hypot(x - 15.5, y - 15.5) > 15) continue;
    const i = (y * size + x) * 4;
    const snow = Math.abs(x - 15.5) < 1.5 || Math.abs(y - 15.5) < 1.5
      || (Math.abs(x-y) < 2 || Math.abs(x+y-31) < 2) && Math.hypot(x-15.5,y-15.5) < 10;
    pixels[i] = snow ? 255 : 171; pixels[i+1] = snow ? 255 : 140;
    pixels[i+2] = snow ? 255 : 222; pixels[i+3] = 255;
  }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: size, height: size }));
  tray.setToolTip('雪乃桌宠 · 双击找回角色');
  tray.on('double-click', restorePetWindow);
  updateTrayMenu();
}

function sendSpeech(dialogue) {
  if (triggerEngine) triggerEngine.playManual(dialogue);
  else deliverSpeech({ ...dialogue, manual: true, triggerName: 'manual' });
}

function sendRandomSpeech() {
  const dialogues = readDialogues();
  if (!dialogues.length) return;
  sendSpeech(dialogues[Math.floor(Math.random() * dialogues.length)]);
}

function getVoiceGroups() {
  const dialogues = readDialogues();
  const groups = [
    ['时间与天气', ['context']],
    ['分时问候', ['time']],
    ['离开与返回', ['return']],
    ['休息提醒', ['work']],
    ['点击回应', ['click']],
    ['连续点击吐槽', ['rapid_click']],
    ['日常随机', ['random']],
    ['深夜与晚安', ['night']]
  ];

  return groups
    .map(([label, categories]) => ({
      label,
      dialogues: dialogues
      .filter((dialogue) => categories.includes(dialogue.category))
        .map((dialogue) => ({ id: dialogue.id, label: dialogue.label }))
    }))
    .filter((group) => group.dialogues.length);
}

function openWeatherSettings() {
  if (weatherSettingsWindow && !weatherSettingsWindow.isDestroyed()) {
    weatherSettingsWindow.show();
    weatherSettingsWindow.focus();
    return;
  }
  weatherSettingsWindow = new BrowserWindow({
    width: 420,
    height: 390,
    resizable: false,
    maximizable: false,
    minimizable: false,
    parent: petWindow || undefined,
    modal: false,
    show: false,
    title: '雪乃桌宠 · 天气设置',
    backgroundColor: '#fff8fb',
    webPreferences: {
      preload: path.join(__dirname, 'weather-settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  weatherSettingsWindow.setMenuBarVisibility(false);
  weatherSettingsWindow.loadFile(path.join(__dirname, 'weather-settings', 'index.html'));
  weatherSettingsWindow.once('ready-to-show', () => weatherSettingsWindow?.show());
  weatherSettingsWindow.on('closed', () => {
    weatherSettingsWindow = null;
  });
}

function openBehaviorSettings() {
  if (behaviorSettingsWindow && !behaviorSettingsWindow.isDestroyed()) {
    behaviorSettingsWindow.show();
    behaviorSettingsWindow.focus();
    return;
  }
  behaviorSettingsWindow = new BrowserWindow({
    width: 440,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: false,
    parent: petWindow || undefined,
    modal: false,
    show: false,
    title: '雪乃桌宠 · 主动行为设置',
    backgroundColor: '#fff8fb',
    webPreferences: {
      preload: path.join(__dirname, 'behavior-settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  behaviorSettingsWindow.setMenuBarVisibility(false);
  behaviorSettingsWindow.loadFile(path.join(__dirname, 'behavior-settings', 'index.html'));
  behaviorSettingsWindow.once('ready-to-show', () => behaviorSettingsWindow?.show());
  behaviorSettingsWindow.on('closed', () => {
    behaviorSettingsWindow = null;
  });
}

function getDebugTriggers() {
  if (app.isPackaged || !triggerEngine) return [];
  return [
    ['早晨问候', 'time_morning'],
    ['离开后返回', 'return_after_idle'],
    ['休眠恢复', 'system_resume'],
    ['久坐 45 分钟', 'continuous_work_45'],
    ['久坐 90 分钟', 'continuous_work_90'],
    ['连续点击', 'click_rapid'],
    ['日常随机', 'random_dialogue'],
    ['深夜晚安', 'time_late_night']
  ].map(([label, name]) => ({ label, name }));
}

function positionSubtitleWindow() {
  if (!petWindow || petWindow.isDestroyed() || !subtitleWindow || subtitleWindow.isDestroyed()) return;
  const petBounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(petBounds);
  const area = display.workArea;
  const scale = Math.min(1.35, Math.max(
    0.62,
    Number(petModelLayout?.modelScale ?? savedState.modelScale) || 1
  ));
  const subtitleWidth = Math.round(BASE_SUBTITLE_WIDTH * scale);
  const subtitleHeight = Math.round(BASE_SUBTITLE_HEIGHT * scale);
  const anchor = petModelLayout
    ? {
        x: petBounds.x + petModelLayout.anchorX,
        y: petBounds.y + petModelLayout.anchorY
      }
    : {
        x: petBounds.x + petBounds.width / 2,
        y: petBounds.y + petBounds.height * (1 - 0.965 * scale)
      };
  const { x, y, tailDirection } = calculateSubtitlePlacement({
    anchor,
    workArea: area,
    subtitleWidth,
    subtitleHeight,
    overlap: Math.round(22 * scale)
  });
  subtitleWindow.setBounds({ x, y, width: subtitleWidth, height: subtitleHeight }, false);
  if (subtitleReady) {
    subtitleWindow.webContents.send('subtitle:position', { tailDirection, scale });
  }
  return { tailDirection, scale };
}

function createSubtitleWindow() {
  subtitleReady = false;
  const subtitleDebug = !app.isPackaged && process.env.YUKINO_SUBTITLE_DEBUG === '1';
  subtitleWindow = new BrowserWindow({
    width: BASE_SUBTITLE_WIDTH,
    height: BASE_SUBTITLE_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: subtitleDebug,
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'subtitle-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  subtitleWindow.setBackgroundColor('#00000000');
  subtitleWindow.setIgnoreMouseEvents(true);
  subtitleWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  subtitleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  subtitleWindow.loadFile(path.join(__dirname, 'subtitle', 'index.html'));
  subtitleWindow.webContents.on('did-finish-load', () => {
    subtitleReady = true;
    if (pendingSubtitle) {
      const payload = pendingSubtitle;
      pendingSubtitle = null;
      showSubtitle(payload);
    } else if (subtitleDebug) {
      showSubtitle({
        token: 900001,
        text: '别误会，我只是认为保持适当的节奏更有效率。',
        durationMs: 12000,
        triggerName: 'subtitle_debug'
      });
    }
  });
  subtitleWindow.on('closed', () => {
    subtitleWindow = null;
    subtitleReady = false;
  });
  positionSubtitleWindow();
}

function showSubtitle(payload) {
  if (!payload?.text || !subtitleWindow || subtitleWindow.isDestroyed()) return;
  activeSubtitleToken = Number(payload.token) || 0;
  if (!subtitleReady) {
    pendingSubtitle = payload;
    return;
  }
  const placement = positionSubtitleWindow() || { tailDirection: 'left', scale: 1 };
  subtitleWindow.webContents.send('subtitle:show', { ...payload, ...placement });
  subtitleWindow.showInactive();
}

function hideSubtitle(token) {
  if (!subtitleWindow || subtitleWindow.isDestroyed()) return;
  const numericToken = Number(token) || 0;
  if (numericToken !== activeSubtitleToken) return;
  if (pendingSubtitle && Number(pendingSubtitle.token) === numericToken) pendingSubtitle = null;
  subtitleWindow.webContents.send('subtitle:hide', numericToken);
  setTimeout(() => {
    if (numericToken === activeSubtitleToken && subtitleWindow && !subtitleWindow.isDestroyed()) {
      subtitleWindow.hide();
    }
  }, 900);
}

function startPointerPolling() {
  if (pointerPollTimer) clearInterval(pointerPollTimer);
  pointerPollTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    petWindow.webContents.send('pet:pointer-position', {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y,
      inside: cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width
        && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height
    });
  }, 50);
}

function petMenuState() {
  const weather = weatherService?.getContext();
  return {
    alwaysOnTop,
    clickThrough,
    weatherReady: Boolean(weather),
    weatherSummary: weather ? `${weather.city} · ${weather.label}` : '尚未设置天气地区',
    menuPositionMode: savedState.petMenuPositionMode === 'manual' ? 'manual' : 'auto',
    rendererStatus: rendererRecovery?.getState() || 'loading',
    expressions: SELECTABLE_EXPRESSIONS.map((item) => ({ ...item })),
    voiceGroups: getVoiceGroups(),
    debugTriggers: getDebugTriggers()
  };
}

function hidePetMenu() {
  if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.hide();
}

function clampPetMenuPosition(x, y) {
  const rounded = { x: Math.round(x), y: Math.round(y) };
  const area = screen.getDisplayNearestPoint(rounded).workArea;
  return calculateMenuBounds(rounded, area, {width: PET_MENU_WIDTH, height: PET_MENU_HEIGHT});
}

function automaticPetMenuPosition() {
  const petBounds = petWindow.getBounds();
  const area = screen.getDisplayMatching(petBounds).workArea;
  const gap = 12;
  const fitted = calculateMenuBounds(petBounds, area);
  const leftX = petBounds.x - fitted.width - gap;
  const rightX = petBounds.x + petBounds.width + gap;
  let x;
  if (leftX >= area.x + 8) x = leftX;
  else if (rightX + fitted.width <= area.x + area.width - 8) x = rightX;
  else x = Math.min(
    Math.max(screen.getCursorScreenPoint().x - Math.round(fitted.width / 2), area.x + 8),
    area.x + area.width - fitted.width - 8
  );
  const cursorY = screen.getCursorScreenPoint().y;
  return calculateMenuBounds({ x, y: cursorY - 38 }, area);
}

function setPetMenuPosition(position) {
  if (!petMenuWindow || petMenuWindow.isDestroyed()) return;
  petMenuPositioning = true;
  if (petMenuPositionGuardTimer) clearTimeout(petMenuPositionGuardTimer);
  petMenuWindow.setBounds(clampPetMenuPosition(position.x, position.y), false);
  petMenuPositionGuardTimer = setTimeout(() => {
    petMenuPositioning = false;
    petMenuPositionGuardTimer = null;
  }, 120);
}

function movePetMenuManually(payload = {}) {
  if (!petMenuWindow || petMenuWindow.isDestroyed()) return;
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const position = clampPetMenuPosition(x, y);
  setPetMenuPosition(position);
  savedState = {
    ...savedState,
    petMenuPositionMode: 'manual',
    petMenuX: position.x,
    petMenuY: position.y
  };
  if (payload.final) {
    writeState({ petMenuPositionMode: 'manual', petMenuX: position.x, petMenuY: position.y });
    if (petMenuReady) petMenuWindow.webContents.send('pet-menu:refresh', petMenuState());
  }
}

function createPetMenuWindow() {
  if (petMenuWindow && !petMenuWindow.isDestroyed()) return;
  petMenuReady = false;
  petMenuWindow = new BrowserWindow({
    width: PET_MENU_WIDTH,
    height: PET_MENU_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'pet-menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  petMenuWindow.setBackgroundColor('#00000000');
  petMenuWindow.setMenuBarVisibility(false);
  petMenuWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  petMenuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petMenuWindow.loadFile(path.join(__dirname, 'pet-menu', 'index.html'));
  petMenuWindow.webContents.on('did-finish-load', () => {
    petMenuReady = true;
    petMenuWindow?.webContents.send('pet-menu:refresh', petMenuState());
  });
  petMenuWindow.on('move', () => {
    if (petMenuPositioning) return;
    if (petMenuPositionSaveTimer) clearTimeout(petMenuPositionSaveTimer);
    petMenuPositionSaveTimer = setTimeout(() => {
      if (!petMenuWindow || petMenuWindow.isDestroyed() || petMenuPositioning) return;
      const [x, y] = petMenuWindow.getPosition();
      writeState({ petMenuPositionMode: 'manual', petMenuX: x, petMenuY: y });
      if (petMenuReady) petMenuWindow.webContents.send('pet-menu:refresh', petMenuState());
    }, 140);
  });
  petMenuWindow.on('blur', hidePetMenu);
  petMenuWindow.on('closed', () => {
    if (petMenuPositionSaveTimer) clearTimeout(petMenuPositionSaveTimer);
    if (petMenuPositionGuardTimer) clearTimeout(petMenuPositionGuardTimer);
    petMenuPositionSaveTimer = null;
    petMenuPositionGuardTimer = null;
    petMenuPositioning = false;
    petMenuWindow = null;
    petMenuReady = false;
  });
}

function showPetMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  createPetMenuWindow();
  if (!petMenuWindow || petMenuWindow.isDestroyed()) return;

  const hasSavedPosition = savedState.petMenuPositionMode === 'manual'
    && Number.isFinite(savedState.petMenuX)
    && Number.isFinite(savedState.petMenuY);
  const position = hasSavedPosition
    ? clampPetMenuPosition(savedState.petMenuX, savedState.petMenuY)
    : automaticPetMenuPosition();
  if (hasSavedPosition
    && (position.x !== savedState.petMenuX || position.y !== savedState.petMenuY)) {
    writeState({ petMenuX: position.x, petMenuY: position.y });
  }
  setPetMenuPosition(position);
  setImmediate(() => {
    if (!petMenuWindow || petMenuWindow.isDestroyed()) return;
    if (petMenuReady) petMenuWindow.webContents.send('pet-menu:refresh', petMenuState());
    petMenuWindow.show();
    petMenuWindow.focus();
  });
}

function runPetMenuAction(payload = {}) {
  const action = String(payload.action || '');
  const value = payload.value;
  let keepOpen = false;

  if (action === 'expression') {
    // Validation lives with the expression list so the menu, the IPC layer and
    // the renderer can never disagree about which names are selectable.
    if (isSelectableExpression(value)) {
      sendExpression(value);
    } else {
      console.warn(`Ignoring unknown expression selection: ${String(value)}`);
    }
  } else if (action === 'random-speech') {
    sendRandomSpeech();
  } else if (action === 'speak-dialogue') {
    const dialogue = readDialogues().find((item) => item.id === value);
    if (dialogue) sendSpeech(dialogue);
  } else if (action === 'announce-time') {
    triggerEngine?.announceTime();
  } else if (action === 'announce-weather') {
    if (!weatherService?.getContext() || !triggerEngine?.announceWeather()) openWeatherSettings();
  } else if (action === 'weather-settings') {
    openWeatherSettings();
  } else if (action === 'behavior-settings') {
    openBehaviorSettings();
  } else if (action === 'renderer-retry') {
    rendererRecovery?.retry();
    keepOpen = true;
  } else if (action === 'scale-step') {
    const amount = Number(value);
    if (petWindow && !petWindow.isDestroyed() && [0.1, -0.1].includes(amount)) {
      petWindow.webContents.send('pet:scale-step', amount);
    }
    keepOpen = true;
  } else if (action === 'scale-reset') {
    petWindow?.webContents.send('pet:scale-reset');
    keepOpen = true;
  } else if (action === 'menu-position-reset') {
    writeState({ petMenuPositionMode: 'auto', petMenuX: null, petMenuY: null });
    if (petWindow && !petWindow.isDestroyed()) setPetMenuPosition(automaticPetMenuPosition());
    keepOpen = true;
  } else if (action === 'always-on-top') {
    setAlwaysOnTop(Boolean(value));
    keepOpen = true;
  } else if (action === 'click-through') {
    setClickThrough(Boolean(value));
    keepOpen = true;
  } else if (action === 'debug-trigger' && !app.isPackaged) {
    const allowed = getDebugTriggers().some((item) => item.name === value);
    if (allowed) triggerEngine?.requestTrigger(value, { force: true });
  } else if (action === 'quit') {
    app.quit();
  } else if (action === 'close') {
    hidePetMenu();
    return petMenuState();
  }

  if (!keepOpen) hidePetMenu();
  return petMenuState();
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  savedState = readState();
  alwaysOnTop = savedState.alwaysOnTop !== false;
  petModelLayout = null;

  const position = Number.isFinite(savedState.x) && Number.isFinite(savedState.y)
    ? clampToWorkArea(savedState.x, savedState.y)
    : defaultBounds();
  const { width, height } = position;

  petWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  petWindow.setMenuBarVisibility(false);
  petWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  behaviorSettingsService = createBehaviorSettingsService({ app });
  weatherService = createWeatherService({
    app,
    onUpdate: (nextContext, previousContext, meta) => {
      triggerEngine?.handleWeatherUpdate(nextContext, previousContext, meta);
      if (petMenuReady) petMenuWindow?.webContents.send('pet-menu:refresh', petMenuState());
    }
  });
  triggerEngine = createTriggerEngine({
    app,
    powerMonitor,
    dialogues: readDialogues(),
    sendSpeech: deliverSpeech,
    cancelSpeech: cancelPetSpeech,
    rendererReady: false,
    getWeatherContext: () => weatherService?.getContext(),
    getBehaviorSettings: () => behaviorSettingsService?.get() || {}
  });
  weatherService.start();
  createSubtitleWindow();
  rendererRecovery = createRendererRecovery({
    pause() {
      triggerEngine?.onRendererUnavailable();
      clearSubtitle();
      if (pointerPollTimer) clearInterval(pointerPollTimer);
      pointerPollTimer = null;
      pointerOverPet = false;
      ignoringMouseEvents = null;
      applyMouseEventMode();
    },
    resume() {
      triggerEngine?.onRendererReady();
      triggerEngine?.start();
      startPointerPolling();
      tray?.setToolTip('雪乃桌宠 · 双击找回角色');
      if (petMenuReady) petMenuWindow?.webContents.send('pet-menu:refresh', petMenuState());
    },
    reload() {
      if (quitting || !petWindow || petWindow.isDestroyed()) return;
      petModelLayout = null;
      petWindow.webContents.reload();
    },
    exhausted(reason) {
      console.error('Renderer recovery stopped:', reason);
      tray?.setToolTip('雪乃桌宠 · 载入失败，右键托盘可重新载入');
      if (petMenuReady) petMenuWindow?.webContents.send('pet-menu:refresh', petMenuState());
    }
  });
  ignoringMouseEvents = null;
  pointerOverPet = false;
  applyMouseEventMode();
  petWindow.webContents.on('console-message', (event, ...legacy) => {
    const details = typeof event?.message === 'string'
      ? event
      : (typeof legacy[0] === 'object'
          ? legacy[0]
          : { level: legacy[0], message: legacy[1], lineNumber: legacy[2], sourceId: legacy[3] });
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  petWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Renderer failed to load: ${code} ${description} ${url}`);
    if (!quitting && code !== -3) rendererRecovery?.failed(description);
  });
  petWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process ended:', details);
    if (!quitting) rendererRecovery?.failed(details.reason);
  });
  petWindow.webContents.on('did-start-loading', () => rendererRecovery?.loading());
  petWindow.webContents.on('did-finish-load', () => {
    console.log('Renderer document loaded.');
  });
  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  petWindow.once('ready-to-show', () => {
    console.log('Desktop-pet window is ready to show.');
    petWindow.showInactive();
    positionSubtitleWindow();
  });
  petWindow.on('move', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    hidePetMenu();
    const [x, y] = petWindow.getPosition();
    writeState({ x, y });
    positionSubtitleWindow();
  });
  petWindow.on('closed', () => {
    rendererRecovery?.dispose();
    rendererRecovery = null;
    if (pointerPollTimer) clearInterval(pointerPollTimer);
    pointerPollTimer = null;
    triggerEngine?.stop();
    triggerEngine = null;
    weatherService?.stop();
    weatherService = null;
    behaviorSettingsService = null;
    if (weatherSettingsWindow && !weatherSettingsWindow.isDestroyed()) {
      weatherSettingsWindow.destroy();
    }
    if (behaviorSettingsWindow && !behaviorSettingsWindow.isDestroyed()) {
      behaviorSettingsWindow.destroy();
    }
    if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.destroy();
    if (subtitleWindow && !subtitleWindow.isDestroyed()) subtitleWindow.destroy();
    petModelLayout = null;
    petWindow = null;
  });
}

app.on('ready', () => {
  if (!hasInstanceLock) return;
  createWindow();
  createTray();

  const registered = globalShortcut.register('CommandOrControl+Alt+Y', restorePetWindow);
  if (!registered) {
    console.warn('Ctrl+Alt+Y unavailable; recover the pet from the tray.');
    tray.setToolTip('雪乃桌宠 · 快捷键被占用，可双击此图标找回角色');
  }
  for (const event of ['display-removed', 'display-added', 'display-metrics-changed']) {
    screen.on(event, () => {
      if (!petWindow || petWindow.isDestroyed()) return;
      const bounds = petWindow.getBounds();
      const position = clampToWorkArea(bounds.x, bounds.y);
      setPetBounds(position);
      positionSubtitleWindow();
      if (petMenuWindow && !petMenuWindow.isDestroyed()) {
        const [x,y] = petMenuWindow.getPosition();
        setPetMenuPosition({x,y});
      }
    });
  }
});

app.on('second-instance', restorePetWindow);
app.on('before-quit', () => { quitting = true; rendererRecovery?.dispose(); flushState(); });

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (pointerPollTimer) clearInterval(pointerPollTimer);
  triggerEngine?.stop();
  weatherService?.stop();
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  flushState();
});

ipcMain.on('pet:move', (_event, payload) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return;
  const next = clampToWorkArea(payload.x, payload.y);
  setPetBounds(next);
  positionSubtitleWindow();
});

ipcMain.on('pet:menu', () => showPetMenu());
ipcMain.handle('pet-menu:get-state', () => petMenuState());
ipcMain.handle('pet-menu:action', (_event, payload) => runPetMenuAction(payload));
ipcMain.on('pet-menu:move', (event, payload) => {
  if (!petMenuWindow || petMenuWindow.isDestroyed() || event.sender !== petMenuWindow.webContents) return;
  movePetMenuManually(payload);
});
ipcMain.on('pet:scale', (_event, scale) => writeState({ modelScale: scale }));
ipcMain.on('pet:layout', (_event, layout) => {
  const anchorX = Number(layout?.anchorX);
  const anchorY = Number(layout?.anchorY);
  const visibleWidth = Number(layout?.visibleWidth);
  const visibleHeight = Number(layout?.visibleHeight);
  const modelScale = Number(layout?.modelScale);
  if (![anchorX, anchorY, visibleWidth, visibleHeight, modelScale].every(Number.isFinite)) return;
  petModelLayout = {
    anchorX,
    anchorY,
    visibleWidth,
    visibleHeight,
    modelScale: Math.min(1.35, Math.max(0.62, modelScale))
  };
  positionSubtitleWindow();
});
ipcMain.on('pet:interaction', (_event, type) => triggerEngine?.handleInteraction(type));
function isPetRenderer(event) {
  return petWindow && !petWindow.isDestroyed() && event.sender === petWindow.webContents;
}
ipcMain.on('pet:renderer-ready', event => {
  if (isPetRenderer(event)) rendererRecovery?.ready();
});
ipcMain.on('pet:renderer-failed', (event, message) => {
  if (isPetRenderer(event)) rendererRecovery?.failed(String(message).slice(0, 500));
});
ipcMain.on('pet:speech-started', (event, payload) => {
  if (isPetRenderer(event) && triggerEngine?.onSpeechStarted(payload)) showSubtitle(payload);
});
ipcMain.on('pet:speech-ended', (event, token) => {
  if (isPetRenderer(event) && triggerEngine?.onSpeechEnded(token)) hideSubtitle(token);
});
ipcMain.on('pet:pointer-over', (_event, isOverPet) => {
  const next = Boolean(isOverPet);
  if (pointerOverPet === next) return;
  pointerOverPet = next;
  applyMouseEventMode();
});
ipcMain.handle('pet:state', () => ({
  modelScale: Number.isFinite(savedState.modelScale) ? savedState.modelScale : 1,
  clickThrough
}));

ipcMain.handle('weather-settings:get', () => weatherService?.getStatus() || null);
ipcMain.handle('weather-settings:save', async (_event, city) => {
  if (!weatherService) throw new Error('天气服务尚未启动。');
  return weatherService.setCity(city);
});
ipcMain.handle('weather-settings:refresh', async () => {
  if (!weatherService) throw new Error('天气服务尚未启动。');
  return weatherService.refresh(true);
});
ipcMain.handle('weather-settings:disable', () => weatherService?.disable() || null);

ipcMain.handle('behavior-settings:get', () => behaviorSettingsService?.get() || null);
ipcMain.handle('behavior-settings:save', (_event, settings) => {
  if (!behaviorSettingsService) throw new Error('主动行为设置尚未启动。');
  const updated = behaviorSettingsService.update(settings);
  triggerEngine?.onSettingsChanged();
  return updated;
});
