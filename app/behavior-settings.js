'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BEHAVIOR_SETTINGS = Object.freeze({
  proactiveEnabled: true,
  frequency: 'normal',
  weatherMode: 'all',
  quietStart: '01:00',
  quietEnd: '06:30'
});

const FREQUENCY_PROFILES = Object.freeze({
  quiet: {
    randomMinMinutes: 45,
    randomMaxMinutes: 75,
    globalCooldownSeconds: 180,
    dailyLimit: 8,
    interactionChance: { single: 0.12, double: 0.35 }
  },
  normal: {
    randomMinMinutes: 20,
    randomMaxMinutes: 40,
    globalCooldownSeconds: 90,
    dailyLimit: 18,
    interactionChance: { single: 0.25, double: 0.60 }
  },
  chatty: {
    randomMinMinutes: 10,
    randomMaxMinutes: 20,
    globalCooldownSeconds: 60,
    dailyLimit: 30,
    interactionChance: { single: 0.45, double: 0.80 }
  }
});

function validClockTime(value, fallback) {
  const text = String(value || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return fallback;
  return text;
}

function normalizeBehaviorSettings(value = {}) {
  const frequency = Object.hasOwn(FREQUENCY_PROFILES, value.frequency)
    ? value.frequency
    : DEFAULT_BEHAVIOR_SETTINGS.frequency;
  const weatherMode = ['all', 'severe', 'off'].includes(value.weatherMode)
    ? value.weatherMode
    : DEFAULT_BEHAVIOR_SETTINGS.weatherMode;
  return {
    proactiveEnabled: value.proactiveEnabled !== false,
    frequency,
    weatherMode,
    quietStart: validClockTime(value.quietStart, DEFAULT_BEHAVIOR_SETTINGS.quietStart),
    quietEnd: validClockTime(value.quietEnd, DEFAULT_BEHAVIOR_SETTINGS.quietEnd)
  };
}

function minutesFromClock(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function isQuietTime(date, settings) {
  const normalized = normalizeBehaviorSettings(settings);
  const start = minutesFromClock(normalized.quietStart);
  const end = minutesFromClock(normalized.quietEnd);
  if (start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function createBehaviorSettingsService({ app }) {
  const settingsPath = path.join(app.getPath('userData'), 'behavior-settings.json');
  let settings;
  try {
    settings = normalizeBehaviorSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch {
    settings = normalizeBehaviorSettings();
  }

  function save() {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  function update(patch) {
    settings = normalizeBehaviorSettings({ ...settings, ...patch });
    save();
    return get();
  }

  function get() {
    return { ...settings };
  }

  return { get, update, settingsPath };
}

module.exports = {
  DEFAULT_BEHAVIOR_SETTINGS,
  FREQUENCY_PROFILES,
  normalizeBehaviorSettings,
  isQuietTime,
  createBehaviorSettingsService
};
