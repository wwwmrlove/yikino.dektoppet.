'use strict';

const weatherSummary = document.getElementById('weather-summary');
const header = document.querySelector('.header');
const weatherAction = document.getElementById('weather-action');
const voiceGroups = document.getElementById('voice-groups');
const alwaysOnTop = document.getElementById('always-on-top');
const clickThrough = document.getElementById('click-through');
const positionMode = document.getElementById('position-mode');
const debugSection = document.getElementById('debug-section');
const debugTriggers = document.getElementById('debug-triggers');
const rendererStatus = document.getElementById('renderer-status');
let menuDrag = null;
let voiceGroupsFingerprint = null;
let debugTriggersFingerprint = null;

function actionButton(label, action, value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  if (value !== undefined) button.dataset.value = value;
  return button;
}

function renderVoiceGroups(groups = []) {
  const fingerprint = JSON.stringify(groups);
  if (fingerprint === voiceGroupsFingerprint) return;
  voiceGroupsFingerprint = fingerprint;
  const expanded = new Set([...voiceGroups.querySelectorAll('details[open]')].map((item) => item.dataset.group));
  voiceGroups.replaceChildren();
  if (!groups.length) {
    voiceGroups.textContent = '暂无可用台词。';
    return;
  }
  for (const group of groups) {
    const details = document.createElement('details');
    details.className = 'voice-group';
    details.dataset.group = String(group.id || group.label);
    details.open = expanded.has(details.dataset.group);
    const summary = document.createElement('summary');
    summary.textContent = `${group.label} · ${group.dialogues.length}`;
    const list = document.createElement('div');
    list.className = 'voice-list';
    for (const dialogue of group.dialogues) {
      list.append(actionButton(dialogue.label, 'speak-dialogue', dialogue.id));
    }
    details.append(summary, list);
    voiceGroups.append(details);
  }
}

function renderDebugTriggers(triggers = []) {
  const fingerprint = JSON.stringify(triggers);
  if (fingerprint === debugTriggersFingerprint) return;
  debugTriggersFingerprint = fingerprint;
  debugTriggers.replaceChildren();
  debugSection.classList.toggle('hidden', !triggers.length);
  for (const trigger of triggers) {
    debugTriggers.append(actionButton(trigger.label, 'debug-trigger', trigger.name));
  }
}

function render(state) {
  if (!state) return;
  weatherSummary.textContent = state.weatherSummary || '尚未设置天气地区';
  weatherAction.lastChild.textContent = state.weatherReady ? ' 当前天气' : ' 设置天气';
  alwaysOnTop.checked = Boolean(state.alwaysOnTop);
  clickThrough.checked = Boolean(state.clickThrough);
  rendererStatus.classList.toggle('hidden', !state.rendererStatus || state.rendererStatus === 'ready');
  rendererStatus.querySelector('span').textContent = state.rendererStatus === 'failed'
    ? '角色载入失败，可点击重新载入。' : '角色正在载入或恢复，暂不播放语音。';
  positionMode.textContent = state.menuPositionMode === 'manual'
    ? '已记住自定义位置'
    : '自动停靠人物侧边';
  renderVoiceGroups(state.voiceGroups);
  renderDebugTriggers(state.debugTriggers);
}

async function runAction(action, value) {
  try {
    render(await window.petMenu.runAction(action, value));
  } catch (error) {
    console.error('Pet menu action failed:', error);
  }
}

function updateMenuPosition(event, final = false) {
  if (!menuDrag) return;
  if (!menuDrag.moved && Math.hypot(event.screenX - menuDrag.startX, event.screenY - menuDrag.startY) < 4) return;
  menuDrag.moved = true;
  window.petMenu.moveWindow(
    Math.round(event.screenX - menuDrag.offsetX),
    Math.round(event.screenY - menuDrag.offsetY),
    final
  );
}

header.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  menuDrag = { pointerId: event.pointerId, offsetX: event.clientX, offsetY: event.clientY,
    startX: event.screenX, startY: event.screenY, moved: false };
  header.setPointerCapture(event.pointerId);
  event.preventDefault();
});

header.addEventListener('pointermove', (event) => {
  if (!menuDrag || menuDrag.pointerId !== event.pointerId || !(event.buttons & 1)) return;
  updateMenuPosition(event);
});

function finishMenuDrag(event) {
  if (!menuDrag || menuDrag.pointerId !== event.pointerId) return;
  updateMenuPosition(event, true);
  if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
  menuDrag = null;
}

header.addEventListener('pointerup', finishMenuDrag);
header.addEventListener('pointercancel', finishMenuDrag);

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const rawValue = button.dataset.value;
  const value = button.dataset.action === 'scale-step' ? Number(rawValue) : rawValue;
  runAction(button.dataset.action, value);
});

alwaysOnTop.addEventListener('change', () => runAction('always-on-top', alwaysOnTop.checked));
clickThrough.addEventListener('change', () => runAction('click-through', clickThrough.checked));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') runAction('close');
});

window.petMenu.onRefresh(render);
window.petMenu.getState().then(render).catch((error) => console.error('Unable to load pet menu:', error));
