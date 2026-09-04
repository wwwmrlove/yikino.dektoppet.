'use strict';

const fs = require('fs');
const path = require('path');
const {
  FREQUENCY_PROFILES,
  isQuietTime,
  normalizeBehaviorSettings
} = require('./behavior-settings');
const {
  coordinateQueue,
  takeNextEvent,
  pruneExpired
} = require('./behavior-coordinator');

const AWAY_SECONDS = 10 * 60;
const LONG_AWAY_SECONDS = 30 * 60;
const REST_RESET_SECONDS = 5 * 60;
const ACTIVE_IDLE_LIMIT_SECONDS = 60;
const SEVERE_WEATHER_TRIGGERS = new Set([
  'weather_heavy_rain',
  'weather_thunder',
  'weather_snow',
  'weather_hot',
  'weather_cold',
  'weather_windy'
]);

const TRIGGER_COOLDOWNS_MS = Object.freeze({
  click_single: 45 * 1000,
  click_double: 30 * 1000,
  click_rapid: 20 * 1000,
  return_after_idle: 30 * 60 * 1000,
  return_after_long_idle: 45 * 60 * 1000,
  system_resume: 30 * 60 * 1000,
  continuous_work_45: 45 * 60 * 1000,
  continuous_work_90: 90 * 60 * 1000,
  random_dialogue: 30 * 60 * 1000,
  clock_morning: 5 * 60 * 1000,
  clock_daytime: 5 * 60 * 1000,
  clock_evening: 5 * 60 * 1000,
  clock_night: 5 * 60 * 1000,
  weather_clear: 120 * 60 * 1000,
  weather_cloudy: 120 * 60 * 1000,
  weather_rain: 90 * 60 * 1000,
  weather_heavy_rain: 60 * 60 * 1000,
  weather_thunder: 60 * 60 * 1000,
  weather_snow: 90 * 60 * 1000,
  weather_hot: 120 * 60 * 1000,
  weather_cold: 120 * 60 * 1000,
  weather_windy: 120 * 60 * 1000,
  time_morning: 4 * 60 * 60 * 1000,
  time_noon: 4 * 60 * 60 * 1000,
  time_afternoon: 4 * 60 * 60 * 1000,
  time_evening: 4 * 60 * 60 * 1000,
  time_late_night: 4 * 60 * 60 * 1000
});

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getClockContext(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  let timeSlot = 'daytime';
  if (minutes >= 390 && minutes < 570) timeSlot = 'morning';
  else if (minutes >= 1080 && minutes < 1350) timeSlot = 'evening';
  else if (minutes >= 1350 || minutes < 390) timeSlot = 'night';

  let scheduledTrigger = null;
  if (minutes >= 390 && minutes < 570) scheduledTrigger = 'time_morning';
  else if (minutes >= 690 && minutes < 810) scheduledTrigger = 'time_noon';
  else if (minutes >= 810 && minutes < 1080) scheduledTrigger = 'time_afternoon';
  else if (minutes >= 1080 && minutes < 1350) scheduledTrigger = 'time_evening';
  else if (minutes >= 1350 || minutes < 60) scheduledTrigger = 'time_late_night';

  return {
    minutes,
    timeSlot,
    scheduledTrigger,
    quiet: minutes >= 60 && minutes < 390
  };
}

function createTriggerEngine({
  app,
  powerMonitor,
  dialogues,
  sendSpeech,
  getWeatherContext = () => null,
  getBehaviorSettings = () => ({})
}) {
  const triggerStatePath = path.join(app.getPath('userData'), 'trigger-state.json');
  let timer = null;
  let started = false;
  let speechActive = false;
  let activeSpeechToken = 0;
  let eventQueue = [];
  let awaySince = null;
  let activeWorkMs = 0;
  let work45Triggered = false;
  let work90Triggered = false;
  let lastTickAt = Date.now();
  let nextRandomAt = Date.now() + randomInterval();

  let state = readTriggerState();
  resetDailyStateIfNeeded();

  function currentBehavior() {
    const settings = normalizeBehaviorSettings(getBehaviorSettings());
    return {
      settings,
      profile: FREQUENCY_PROFILES[settings.frequency]
    };
  }

  function randomInterval() {
    const { profile } = currentBehavior();
    const minimum = profile.randomMinMinutes * 60 * 1000;
    const maximum = profile.randomMaxMinutes * 60 * 1000;
    return minimum + Math.random() * (maximum - minimum);
  }

  function readTriggerState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(triggerStatePath, 'utf8'));
      return {
        date: parsed.date || dateKey(),
        autoCount: Number(parsed.autoCount) || 0,
        lastSpeechAt: Number(parsed.lastSpeechAt) || 0,
        triggerLastAt: parsed.triggerLastAt || {},
        dialogueLastAt: parsed.dialogueLastAt || {},
        greetedSlots: parsed.greetedSlots || {},
        recentIds: Array.isArray(parsed.recentIds) ? parsed.recentIds.slice(-10) : [],
        weatherSignature: parsed.weatherSignature || ''
      };
    } catch {
      return {
        date: dateKey(),
        autoCount: 0,
        lastSpeechAt: 0,
        triggerLastAt: {},
        dialogueLastAt: {},
        greetedSlots: {},
        recentIds: [],
        weatherSignature: ''
      };
    }
  }

  function saveTriggerState() {
    try {
      fs.mkdirSync(path.dirname(triggerStatePath), { recursive: true });
      fs.writeFileSync(triggerStatePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      console.error('Unable to save trigger state:', error);
    }
  }

  function resetDailyStateIfNeeded() {
    const today = dateKey();
    if (state.date === today) return;
    state.date = today;
    state.autoCount = 0;
    state.greetedSlots = {};
    state.recentIds = [];
    saveTriggerState();
  }

  function selectDialogue(
    triggerName,
    now = Date.now(),
    ignoreTimeSlot = false,
    ignoreDialogueCooldown = false
  ) {
    const { timeSlot } = getClockContext(new Date(now));
    const candidates = dialogues.filter((dialogue) => {
      if (!dialogue.autoEnabled || !dialogue.triggers?.includes(triggerName)) return false;
      if (!ignoreTimeSlot && Array.isArray(dialogue.timeSlots) && dialogue.timeSlots.length
        && !dialogue.timeSlots.includes(timeSlot)) return false;
      const dialogueCooldown = Math.max(0, Number(dialogue.cooldownMinutes) || 0) * 60 * 1000;
      return ignoreDialogueCooldown
        || now - (state.dialogueLastAt[dialogue.id] || 0) >= dialogueCooldown;
    });
    if (!candidates.length) return null;
    const recent = new Set(state.recentIds.slice(-8));
    const fresh = candidates.filter((dialogue) => !recent.has(dialogue.id));
    const pool = fresh.length ? fresh : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function recordDispatch(dialogue, triggerName, manual) {
    const now = Date.now();
    state.lastSpeechAt = now;
    state.dialogueLastAt[dialogue.id] = now;
    state.recentIds = [...state.recentIds.filter((id) => id !== dialogue.id), dialogue.id].slice(-10);
    if (!manual) {
      state.autoCount += 1;
      state.triggerLastAt[triggerName] = now;
      if (triggerName.startsWith('time_')) state.greetedSlots[triggerName] = state.date;
    }
    saveTriggerState();
  }

  function dispatch(dialogue, triggerName, manual = false) {
    if (!dialogue) return false;
    // Reserve the speaking slot before IPC delivery. Without this reservation,
    // two menu clicks in the same event-loop turn can start two audio elements.
    speechActive = true;
    activeSpeechToken = 0;
    sendSpeech({ ...dialogue, triggerName, manual });
    recordDispatch(dialogue, triggerName, manual);
    return true;
  }

  function weatherTriggerName(context) {
    if (!context) return null;
    if (context.state === 'thunder') return 'weather_thunder';
    if (context.state === 'heavy_rain') return 'weather_heavy_rain';
    if (context.state === 'snow') return 'weather_snow';
    if (context.state === 'rain') return 'weather_rain';
    if (context.hot) return 'weather_hot';
    if (context.cold) return 'weather_cold';
    if (context.windy) return 'weather_windy';
    return `weather_${context.state}`;
  }

  function weatherSummary(context) {
    const temperature = Number.isFinite(context.temperature)
      ? `${Math.round(context.temperature)}℃`
      : '';
    const apparent = Number.isFinite(context.apparentTemperature)
      ? `，体感${Math.round(context.apparentTemperature)}℃`
      : '';
    return `${context.city}：${context.label}${temperature ? `，${temperature}` : ''}${apparent}。`;
  }

  function prepareDialogue(dialogue, triggerName) {
    if (!triggerName.startsWith('weather_')) return dialogue;
    const context = getWeatherContext();
    if (!context) return null;
    return {
      ...dialogue,
      translation: `${weatherSummary(context)}${dialogue.translation}`,
      weatherContext: context
    };
  }

  function weatherAllowed(triggerName, manual = false) {
    if (manual || !triggerName.startsWith('weather_')) return true;
    const mode = currentBehavior().settings.weatherMode;
    if (mode === 'off') return false;
    return mode === 'all' || SEVERE_WEATHER_TRIGGERS.has(triggerName);
  }

  function queueDialogue(dialogue, triggerName, options = {}) {
    if (!dialogue) return false;
    const event = {
      dialogue,
      triggerName,
      manual: Boolean(options.manual),
      bypassCooldown: Boolean(options.bypassCooldown),
      priority: options.manual
        ? 100
        : Math.max(Number(dialogue.priority) || 0, Number(options.priority) || 0)
    };
    eventQueue = coordinateQueue(eventQueue, event);
    flushQueue();
    return true;
  }

  function requestTrigger(triggerName, options = {}) {
    resetDailyStateIfNeeded();
    const now = Date.now();
    const { settings, profile } = currentBehavior();
    const userInteraction = triggerName.startsWith('click_');
    if (!options.force && !userInteraction && !settings.proactiveEnabled) return false;
    if (!options.force && !userInteraction && isQuietTime(new Date(now), settings)) return false;
    if (!options.force && !userInteraction && state.autoCount >= profile.dailyLimit) return false;
    if (!weatherAllowed(triggerName, Boolean(options.force))) return false;

    const eventCooldown = TRIGGER_COOLDOWNS_MS[triggerName] || 30 * 60 * 1000;
    if (!options.force && now - (state.triggerLastAt[triggerName] || 0) < eventCooldown) return false;

    const selectedDialogue = selectDialogue(
      triggerName,
      now,
      Boolean(options.force),
      Boolean(options.force)
    );
    const dialogue = selectedDialogue && prepareDialogue(selectedDialogue, triggerName);
    if (!dialogue) return false;
    return queueDialogue(dialogue, triggerName, {
      bypassCooldown: Boolean(options.force)
    });
  }

  function playManual(dialogue) {
    return queueDialogue(dialogue, 'manual', { manual: true, bypassCooldown: true });
  }

  function announceTime() {
    const now = new Date();
    const triggerName = `clock_${getClockContext(now).timeSlot}`;
    const selectedDialogue = selectDialogue(triggerName, now.getTime(), true, true);
    if (!selectedDialogue) return false;
    const exactTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return queueDialogue({
      ...selectedDialogue,
      translation: `现在是 ${exactTime}。${selectedDialogue.translation}`
    }, triggerName, { manual: true, bypassCooldown: true });
  }

  function announceWeather() {
    const context = getWeatherContext();
    const triggerName = weatherTriggerName(context);
    if (!triggerName) return false;
    const selectedDialogue = selectDialogue(triggerName, Date.now(), true, true);
    return queueDialogue(prepareDialogue(selectedDialogue, triggerName), triggerName, {
      manual: true,
      bypassCooldown: true
    });
  }

  function handleWeatherUpdate(nextContext, previousContext) {
    if (!nextContext) return false;
    const previousSignature = state.weatherSignature;
    state.weatherSignature = nextContext.signature;
    saveTriggerState();
    if (!previousContext || !previousSignature || previousSignature === nextContext.signature) {
      return false;
    }
    const becameImportant = nextContext.severe
      || nextContext.state === 'snow'
      || nextContext.state === 'rain'
      || nextContext.hot
      || nextContext.cold;
    return becameImportant ? requestTrigger(weatherTriggerName(nextContext)) : false;
  }

  function handleInteraction(type) {
    const chances = currentBehavior().profile.interactionChance;
    if (type === 'single' && Math.random() >= chances.single) return false;
    if (type === 'double' && Math.random() >= chances.double) return false;
    const triggerName = type === 'rapid'
      ? 'click_rapid'
      : (type === 'double' ? 'click_double' : 'click_single');
    return requestTrigger(triggerName);
  }

  function runScheduledChecks(idleSeconds) {
    const now = Date.now();
    const clock = getClockContext(new Date(now));
    if (idleSeconds < ACTIVE_IDLE_LIMIT_SECONDS && clock.scheduledTrigger
      && state.greetedSlots[clock.scheduledTrigger] !== state.date) {
      requestTrigger(clock.scheduledTrigger);
    }

    if (idleSeconds < ACTIVE_IDLE_LIMIT_SECONDS && now >= nextRandomAt) {
      const weatherContext = getWeatherContext();
      const weatherTrigger = weatherTriggerName(weatherContext);
      if (weatherTrigger && weatherAllowed(weatherTrigger) && Math.random() < 0.35) {
        requestTrigger(weatherTrigger);
      } else {
        requestTrigger('random_dialogue');
      }
      nextRandomAt = now + randomInterval();
    }
  }

  function updateActivity(idleSeconds, elapsedMs) {
    if (idleSeconds >= AWAY_SECONDS && awaySince === null) {
      awaySince = Date.now() - idleSeconds * 1000;
    } else if (awaySince !== null && idleSeconds < 5) {
      const awayDuration = Date.now() - awaySince;
      awaySince = null;
      activeWorkMs = 0;
      work45Triggered = false;
      work90Triggered = false;
      requestTrigger(awayDuration >= LONG_AWAY_SECONDS * 1000
        ? 'return_after_long_idle'
        : 'return_after_idle');
    }

    if (idleSeconds >= REST_RESET_SECONDS) {
      activeWorkMs = 0;
      work45Triggered = false;
      work90Triggered = false;
      return;
    }
    if (idleSeconds >= ACTIVE_IDLE_LIMIT_SECONDS) return;

    activeWorkMs += elapsedMs;
    if (!work45Triggered && activeWorkMs >= 45 * 60 * 1000) {
      work45Triggered = true;
      requestTrigger('continuous_work_45');
    }
    if (!work90Triggered && activeWorkMs >= 90 * 60 * 1000) {
      work90Triggered = true;
      requestTrigger('continuous_work_90');
    }
  }

  function flushQueue() {
    eventQueue = pruneExpired(eventQueue);
    if (!eventQueue.length || speechActive) return false;
    const now = Date.now();
    const next = eventQueue[0];
    const { settings, profile } = currentBehavior();
    const userEvent = next.manual || next.family === 'interaction';
    if (!userEvent && !settings.proactiveEnabled) {
      eventQueue = eventQueue.filter((event) => (
        event.manual || event.family === 'interaction'
      ));
      return false;
    }
    if (!userEvent && isQuietTime(new Date(now), settings)) return false;
    if (!next.manual && next.family !== 'interaction' && state.autoCount >= profile.dailyLimit) {
      eventQueue = eventQueue.filter((event) => event.manual || event.family === 'interaction');
      return false;
    }
    const cooldownMs = profile.globalCooldownSeconds * 1000;
    if (!next.bypassCooldown && now - state.lastSpeechAt < cooldownMs) return false;
    const taken = takeNextEvent(eventQueue, now);
    eventQueue = taken.queue;
    return dispatch(taken.event.dialogue, taken.event.triggerName, taken.event.manual);
  }

  function tick() {
    const now = Date.now();
    const elapsedMs = Math.min(30 * 1000, Math.max(0, now - lastTickAt));
    lastTickAt = now;
    resetDailyStateIfNeeded();
    const idleSeconds = powerMonitor.getSystemIdleTime();
    updateActivity(idleSeconds, elapsedMs);
    runScheduledChecks(idleSeconds);
    flushQueue();
  }

  // Use a local timer wrapper because Electron's main process does not expose window.
  function scheduleResumeTrigger() {
    setTimeout(() => requestTrigger('system_resume'), 3000);
  }

  function start() {
    if (started) return;
    started = true;
    lastTickAt = Date.now();
    timer = setInterval(tick, 15 * 1000);
    powerMonitor.on('resume', scheduleResumeTrigger);
    powerMonitor.on('unlock-screen', scheduleResumeTrigger);
    setTimeout(() => {
      const triggerName = getClockContext().scheduledTrigger;
      if (triggerName) requestTrigger(triggerName);
    }, 8 * 1000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    powerMonitor.removeListener('resume', scheduleResumeTrigger);
    powerMonitor.removeListener('unlock-screen', scheduleResumeTrigger);
    started = false;
  }

  function onSpeechStarted(payload) {
    speechActive = true;
    activeSpeechToken = Number(payload?.token) || activeSpeechToken;
  }

  function onSpeechEnded(token) {
    const numericToken = Number(token) || 0;
    if (activeSpeechToken && numericToken && numericToken !== activeSpeechToken) return;
    speechActive = false;
    activeSpeechToken = 0;
    flushQueue();
  }

  function onSettingsChanged() {
    nextRandomAt = Date.now() + randomInterval();
    const settings = currentBehavior().settings;
    eventQueue = eventQueue.filter((event) => (
      event.manual || event.family === 'interaction' || (
        settings.proactiveEnabled && weatherAllowed(event.triggerName)
      )
    ));
    flushQueue();
  }

  return {
    start,
    stop,
    requestTrigger,
    playManual,
    announceTime,
    announceWeather,
    handleWeatherUpdate,
    handleInteraction,
    onSpeechStarted,
    onSpeechEnded,
    onSettingsChanged,
    getDebugState: () => ({
      ...state,
      speechActive,
      activeSpeechToken,
      activeWorkMs,
      eventQueue
    })
  };
}

module.exports = {
  createTriggerEngine,
  getClockContext
};
