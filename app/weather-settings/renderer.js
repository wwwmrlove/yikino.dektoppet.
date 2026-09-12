'use strict';

const cityInput = document.querySelector('#city');
const saveButton = document.querySelector('#save');
const refreshButton = document.querySelector('#refresh');
const disableButton = document.querySelector('#disable');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const message = document.querySelector('#message');
let currentStatus = null;
let actionVersion = 0;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function updatedAt(value) {
  return finite(value) && value > 0
    ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
}

function render(status) {
  currentStatus = status;
  const settings = status?.settings;
  const context = status?.context;
  const lastSuccess = updatedAt(status?.lastSuccessAt || context?.fetchedAt);
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
    const source = status?.lastError
      ? `获取失败，正在使用缓存 · ${status.lastError}`
      : (context.stale || status?.dataSource === 'cache' ? '当前显示缓存数据' : '本次天气获取成功');
    statusDetail.textContent = `${precision} · ${parts.join(' · ')} · ${source}${lastSuccess ? ` · 最后成功更新：${lastSuccess}` : ''}`;
  } else {
    statusTitle.textContent = `${settings.city} · ${status?.lastError ? '暂无可用天气' : '等待天气数据'}`;
    statusDetail.textContent = `${status?.lastError || '首次获取可能需要几秒钟。'}${lastSuccess ? ` · 最后成功更新：${lastSuccess}（缓存已过期）` : ''}`;
  }
  refreshButton.disabled = !settings?.enabled || status?.updating;
  disableButton.disabled = !settings?.enabled;
  saveButton.disabled = Boolean(status?.updating);
}

async function run(action, successText) {
  const version = ++actionVersion;
  message.textContent = '正在处理…';
  for (const button of [saveButton, refreshButton]) button.disabled = true;
  // A user must still be able to stop weather while a refresh is in flight.
  disableButton.disabled = !currentStatus?.settings?.enabled;
  try {
    const status = await action();
    if (version !== actionVersion) return;
    render(status);
    if (status?.operation?.outcome === 'superseded') {
      message.textContent = '此次请求已取消，当前设置已保留。';
    } else if (status?.operation?.outcome === 'busy') {
      message.textContent = '天气仍在获取中，请稍候。';
    } else if (status?.settings?.enabled && status?.lastError) {
      const saved = status?.operation?.settingsSaved ? '地点已保存；' : '';
      message.textContent = `${saved}天气获取失败${status?.context ? '，正在使用已有缓存' : '，暂无可用缓存'}：${status.lastError}`;
    } else {
      message.textContent = successText;
    }
  } catch (error) {
    if (version !== actionVersion) return;
    message.textContent = error?.message || '操作失败，请稍后再试。';
    try {
      const status = await window.weatherSettings.getStatus();
      if (version === actionVersion) render(status);
    } catch {
      saveButton.disabled = false;
    }
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
