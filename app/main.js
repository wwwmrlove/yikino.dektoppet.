'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, Menu, powerMonitor, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { createTriggerEngine } = require('./trigger-engine');
const { createWeatherService } = require('./weather-service');
const { createBehaviorSettingsService } = require('./behavior-settings');
const { calculateSubtitlePlacement } = require('./subtitle-placement');

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 820;
const BASE_SUBTITLE_WIDTH = 352;
const BASE_SUBTITLE_HEIGHT = 198;
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
let alwaysOnTop = true;
let clickThrough = false;
let pointerOverPet = false;
let ignoringMouseEvents = null;
let pointerPollTimer = null;
let savedState = {};
let petModelLayout = null;

const statePath = () => path.join(app.getPath('userData'), STATE_FILE);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  savedState = { ...savedState, ...patch };
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(savedState, null, 2), 'utf8');
  } catch (error) {
    console.error('Unable to save desktop-pet state:', error);
  }
}

function clampToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const modelScale = Number.isFinite(savedState.modelScale)
    ? Math.min(1.35, Math.max(0.62, savedState.modelScale))
    : 1;
  // The model is bottom-aligned. At smaller scales the upper part of the fixed-size
  // transparent window is empty, so allow that padding (plus a small margin) above the screen.
  const estimatedVisibleHeight = height * 0.965 * modelScale;
  const transparentTopPadding = Math.max(0, height - estimatedVisibleHeight);
  const allowedTopOverflow = Math.min(height * 0.45, transparentTopPadding + 32);
  return {
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - width),
    y: Math.min(
      Math.max(Math.round(y), Math.round(area.y - allowedTopOverflow)),
      area.y + area.height - height
    )
  };
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: DEFAULT_WIDTH,
    height: Math.min(DEFAULT_HEIGHT, area.height - 24),
    x: area.x + area.width - DEFAULT_WIDTH - 24,
    y: area.y + area.height - Math.min(DEFAULT_HEIGHT, area.height - 24) - 12
  };
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
  }
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

function buildVoiceMenu() {
  const dialogues = readDialogues();
  if (!dialogues.length) return [{ label: '暂无可用台词', enabled: false }];

  const randomDialogue = () => dialogues[Math.floor(Math.random() * dialogues.length)];
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

  const submenu = [
    { label: '随机台词', click: () => sendSpeech(randomDialogue()) },
    { type: 'separator' }
  ];
  for (const [label, categories] of groups) {
    const items = dialogues
      .filter((dialogue) => categories.includes(dialogue.category))
      .map((dialogue) => ({ label: dialogue.label, click: () => sendSpeech(dialogue) }));
    if (items.length) submenu.push({ label, submenu: items });
  }
  return submenu;
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

function buildDebugTriggerItems() {
  if (app.isPackaged || !triggerEngine) return [];
  const triggers = [
    ['早晨问候', 'time_morning'],
    ['离开后返回', 'return_after_idle'],
    ['休眠恢复', 'system_resume'],
    ['久坐 45 分钟', 'continuous_work_45'],
    ['久坐 90 分钟', 'continuous_work_90'],
    ['连续点击', 'click_rapid'],
    ['日常随机', 'random_dialogue'],
    ['深夜晚安', 'time_late_night']
  ];
  return [
    { type: 'separator' },
    {
      label: '测试自动触发（开发）',
      submenu: triggers.map(([label, name]) => ({
        label,
        click: () => triggerEngine.requestTrigger(name, { force: true })
      }))
    }
  ];
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

function showPetMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '恢复默认表情', click: () => sendExpression('default') },
    { label: '温柔微笑', click: () => sendExpression('soft_smile') },
    { label: '不高兴', click: () => sendExpression('annoyed') },
    { label: '惊讶', click: () => sendExpression('surprised') },
    { label: '担心', click: () => sendExpression('worried') },
    { type: 'separator' },
    { label: '随机说一句', click: sendRandomSpeech },
    { label: '让雪乃说话', submenu: buildVoiceMenu() },
    { type: 'separator' },
    { label: '告诉我现在的时间', click: () => triggerEngine?.announceTime() },
    {
      label: weatherService?.getContext() ? '告诉我现在的天气' : '设置天气城市…',
      click: () => {
        if (!weatherService?.getContext() || !triggerEngine?.announceWeather()) openWeatherSettings();
      }
    },
    { label: '天气设置…', click: openWeatherSettings },
    { label: '主动行为设置…', click: openBehaviorSettings },
    ...buildDebugTriggerItems(),
    { type: 'separator' },
    { label: '放大', click: () => petWindow.webContents.send('pet:scale-step', 0.1) },
    { label: '缩小', click: () => petWindow.webContents.send('pet:scale-step', -0.1) },
    { label: '恢复大小', click: () => petWindow.webContents.send('pet:scale-reset') },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        petWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
        if (subtitleWindow && !subtitleWindow.isDestroyed()) {
          subtitleWindow.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
        }
        writeState({ alwaysOnTop });
      }
    },
    {
      label: '鼠标穿透（Ctrl+Alt+Y 恢复）',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => setClickThrough(item.checked)
    },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() }
  ]);
  menu.popup({ window: petWindow });
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function createWindow() {
  savedState = readState();
  alwaysOnTop = savedState.alwaysOnTop !== false;
  petModelLayout = null;

  const initial = defaultBounds();
  const width = initial.width;
  const height = initial.height;
  const position = Number.isFinite(savedState.x) && Number.isFinite(savedState.y)
    ? clampToWorkArea(savedState.x, savedState.y, width, height)
    : { x: initial.x, y: initial.y };

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
    onUpdate: (nextContext, previousContext) => {
      triggerEngine?.handleWeatherUpdate(nextContext, previousContext);
    }
  });
  triggerEngine = createTriggerEngine({
    app,
    powerMonitor,
    dialogues: readDialogues(),
    sendSpeech: deliverSpeech,
    getWeatherContext: () => weatherService?.getContext(),
    getBehaviorSettings: () => behaviorSettingsService?.get() || {}
  });
  weatherService.start();
  createSubtitleWindow();
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
  });
  petWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process ended:', details);
  });
  petWindow.webContents.on('did-finish-load', () => {
    console.log('Renderer document loaded.');
    triggerEngine?.start();
  });
  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  petWindow.once('ready-to-show', () => {
    console.log('Desktop-pet window is ready to show.');
    petWindow.showInactive();
    positionSubtitleWindow();
    startPointerPolling();
  });
  petWindow.on('move', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const [x, y] = petWindow.getPosition();
    writeState({ x, y });
    positionSubtitleWindow();
  });
  petWindow.on('closed', () => {
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
    if (subtitleWindow && !subtitleWindow.isDestroyed()) subtitleWindow.destroy();
    petModelLayout = null;
    petWindow = null;
  });
}

app.on('ready', () => {
  createWindow();

  globalShortcut.register('CommandOrControl+Alt+Y', () => {
    setClickThrough(false);
    if (petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (pointerPollTimer) clearInterval(pointerPollTimer);
  triggerEngine?.stop();
  weatherService?.stop();
  globalShortcut.unregisterAll();
});

ipcMain.on('pet:move', (_event, payload) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [width, height] = petWindow.getSize();
  const next = clampToWorkArea(payload.x, payload.y, width, height);
  petWindow.setPosition(next.x, next.y, false);
  positionSubtitleWindow();
});

ipcMain.on('pet:menu', () => showPetMenu());
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
ipcMain.on('pet:speech-started', (_event, payload) => {
  triggerEngine?.onSpeechStarted(payload);
  showSubtitle(payload);
});
ipcMain.on('pet:speech-ended', (_event, token) => {
  triggerEngine?.onSpeechEnded(token);
  hideSubtitle(token);
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
