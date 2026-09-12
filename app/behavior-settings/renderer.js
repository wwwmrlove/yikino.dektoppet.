'use strict';

const enabled = document.querySelector('#enabled');
const frequency = document.querySelector('#frequency');
const weatherMode = document.querySelector('#weather-mode');
const quietStart = document.querySelector('#quiet-start');
const quietEnd = document.querySelector('#quiet-end');
const saveButton = document.querySelector('#save');
const message = document.querySelector('#message');

function render(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('主动行为设置暂不可用，请关闭此窗口后重试。');
  }
  enabled.checked = settings.proactiveEnabled !== false;
  frequency.value = settings.frequency;
  weatherMode.value = settings.weatherMode;
  quietStart.value = settings.quietStart;
  quietEnd.value = settings.quietEnd;
}

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  message.textContent = '正在保存…';
  try {
    const settings = await window.behaviorSettings.save({
      proactiveEnabled: enabled.checked,
      frequency: frequency.value,
      weatherMode: weatherMode.value,
      quietStart: quietStart.value,
      quietEnd: quietEnd.value
    });
    render(settings);
    message.textContent = '设置已立即生效。';
  } catch (error) {
    message.textContent = `保存失败：${error?.message || '请稍后重试。'}`;
  } finally {
    saveButton.disabled = false;
  }
});

saveButton.disabled = true;
window.behaviorSettings.get().then((settings) => {
  render(settings);
  saveButton.disabled = false;
}).catch((error) => {
  message.textContent = `读取设置失败：${error?.message || '请关闭此窗口后重试。'}`;
});
