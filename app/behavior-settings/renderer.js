'use strict';

const enabled = document.querySelector('#enabled');
const frequency = document.querySelector('#frequency');
const weatherMode = document.querySelector('#weather-mode');
const quietStart = document.querySelector('#quiet-start');
const quietEnd = document.querySelector('#quiet-end');
const saveButton = document.querySelector('#save');
const message = document.querySelector('#message');

function render(settings) {
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
    message.textContent = error?.message || '保存失败。';
  } finally {
    saveButton.disabled = false;
  }
});

window.behaviorSettings.get().then(render);
