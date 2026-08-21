'use strict';

const cloud = document.getElementById('cloud');
const subtitleText = document.getElementById('subtitle-text');

let activeToken = 0;
let segmentTimer = null;
let hideTimer = null;

function clearTimers() {
  window.clearTimeout(segmentTimer);
  window.clearTimeout(hideTimer);
  segmentTimer = null;
  hideTimer = null;
}

function splitSubtitle(text) {
  const normalized = String(text || '').trim();
  if (normalized.length <= 28) return [normalized];
  const clauses = normalized.match(/[^，。！？；]+[，。！？；]?/g) || [normalized];
  if (clauses.length < 2) return [normalized];
  const totalLength = clauses.reduce((sum, clause) => sum + clause.length, 0);
  const target = totalLength / 2;
  let first = '';
  let second = '';
  for (const clause of clauses) {
    if (!second && first.length < target) first += clause;
    else second += clause;
  }
  return second ? [first.trim(), second.trim()] : [normalized];
}

function replaceText(text) {
  subtitleText.classList.add('changing');
  window.setTimeout(() => {
    subtitleText.textContent = text;
    subtitleText.classList.remove('changing');
  }, 100);
}

function applyPlacement(payload) {
  cloud.classList.toggle('tail-right', payload?.tailDirection === 'right');
  const scale = Math.min(1.35, Math.max(0.62, Number(payload?.scale) || 1));
  const root = document.documentElement;
  const setScaledPixels = (name, pixels) => root.style.setProperty(name, `${pixels * scale}px`);
  setScaledPixels('--cloud-font-size', 16);
  setScaledPixels('--cloud-padding-top', 48);
  setScaledPixels('--cloud-padding-side', 58);
  setScaledPixels('--cloud-padding-bottom', 54);
  setScaledPixels('--cloud-shadow-y', 7);
  setScaledPixels('--cloud-shadow-blur', 14);
  setScaledPixels('--cloud-enter-y', 10);
  setScaledPixels('--cloud-exit-y', -8);
  setScaledPixels('--cloud-fill-top', 41);
  setScaledPixels('--cloud-fill-side', 49);
  setScaledPixels('--cloud-fill-bottom', 46);
  setScaledPixels('--text-shadow-blur', 18);
  setScaledPixels('--text-shadow-spread', 12);
}

function showSubtitle(payload) {
  const token = Number(payload?.token) || 0;
  const text = String(payload?.text || '').trim();
  if (!text) return;
  activeToken = token;
  clearTimers();
  applyPlacement(payload);
  const segments = splitSubtitle(text);
  subtitleText.textContent = segments[0];
  cloud.classList.remove('leaving');
  window.requestAnimationFrame(() => cloud.classList.add('visible'));

  if (segments.length > 1) {
    const durationMs = Math.max(3600, Number(payload.durationMs) || 7000);
    const share = segments[0].length / (segments[0].length + segments[1].length);
    const switchAt = Math.max(1800, Math.min(durationMs - 1800, durationMs * share));
    segmentTimer = window.setTimeout(() => {
      if (activeToken === token) replaceText(segments[1]);
    }, switchAt);
  }
}

function hideSubtitle(token) {
  if (Number(token) !== activeToken) return;
  clearTimers();
  hideTimer = window.setTimeout(() => {
    cloud.classList.add('leaving');
    cloud.classList.remove('visible');
  }, 300);
}

window.subtitleCloud.onShow(showSubtitle);
window.subtitleCloud.onHide(hideSubtitle);
window.subtitleCloud.onPosition(applyPlacement);
