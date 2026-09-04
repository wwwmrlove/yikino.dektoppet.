'use strict';

const weatherSummary = document.getElementById('weather-summary');
const weatherAction = document.getElementById('weather-action');
const voiceGroups = document.getElementById('voice-groups');
const alwaysOnTop = document.getElementById('always-on-top');
const clickThrough = document.getElementById('click-through');
const debugSection = document.getElementById('debug-section');
const debugTriggers = document.getElementById('debug-triggers');

function actionButton(label, action, value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = action;
  if (value !== undefined) button.dataset.value = value;
  return button;
}

function renderVoiceGroups(groups = []) {
  voiceGroups.replaceChildren();
  if (!groups.length) {
    voiceGroups.textContent = '暂无可用台词。';
    return;
  }
  for (const group of groups) {
    const details = document.createElement('details');
    details.className = 'voice-group';
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
