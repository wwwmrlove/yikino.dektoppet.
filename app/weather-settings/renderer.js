'use strict';

const cityInput = document.querySelector('#city');
const saveButton = document.querySelector('#save');
const refreshButton = document.querySelector('#refresh');
const disableButton = document.querySelector('#disable');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const message = document.querySelector('#message');

function finite(value) {
  return Number.isFinite(Number(value));
}

function render(status) {
  const settings = status?.settings;
  const context = status?.context;
  if (settings?.city && document.activeElement !== cityInput) {
    cityInput.value = settings.query || settings.city.split('，')[0];
  }
  if (!settings?.enabled) {
    statusTitle.textContent = '天气功能已停用';
    statusDetail.textContent = settings?.city ? `已保留城市：${settings.city}` : '输入城市并保存即可启用。';
  } else if (context) {
    statusTitle.textContent = `${context.city} · ${context.label}`;
    const parts = [];
    if (finite(context.temperature)) parts.push(`${Math.round(context.temperature)}℃`);
    if (finite(context.apparentTemperature)) parts.push(`体感 ${Math.round(context.apparentTemperature)}℃`);
    if (finite(context.windSpeed)) parts.push(`风速 ${Math.round(context.windSpeed)} km/h`);
    const precision = context.precision === 'district' ? '区县级定位' : '城市级定位';
    statusDetail.textContent = `${precision} · ${parts.join(' · ')}${context.stale ? ' · 当前显示缓存数据' : ' · 已缓存最新数据'}`;
  } else {
    statusTitle.textContent = `${settings.city} · 等待天气数据`;
    statusDetail.textContent = status?.lastError || '首次获取可能需要几秒钟。';
  }
  refreshButton.disabled = !settings?.enabled || status?.updating;
  disableButton.disabled = !settings?.enabled || status?.updating;
  saveButton.disabled = Boolean(status?.updating);
}

async function run(action, successText) {
  message.textContent = '正在处理…';
  for (const button of [saveButton, refreshButton, disableButton]) button.disabled = true;
  try {
    const status = await action();
    render(status);
    message.textContent = successText;
  } catch (error) {
    message.textContent = error?.message || '操作失败，请稍后再试。';
    render(await window.weatherSettings.getStatus());
  }
}

saveButton.addEventListener('click', () => run(
  () => window.weatherSettings.saveCity(cityInput.value),
  '城市和最新天气已保存。'
));
refreshButton.addEventListener('click', () => run(
  () => window.weatherSettings.refresh(),
  '天气已经刷新。'
));
disableButton.addEventListener('click', () => run(
  () => window.weatherSettings.disable(),
  '天气主动台词已停用。'
));
cityInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveButton.click();
});

window.weatherSettings.getStatus().then(render);
