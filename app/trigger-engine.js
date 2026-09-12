'use strict';

const fs = require('fs');
const path = require('path');
const { createJsonStore } = require('./json-store');
const jsonStore = createJsonStore(fs);
const {
  FREQUENCY_PROFILES,
  isQuietTime,
  normalizeBehaviorSettings
} = require('./behavior-settings');
const {
  coordinateQueue,
  pruneExpired
} = require('./behavior-coordinator');

const AWAY_SECONDS = 10 * 60;
const LONG_AWAY_SECONDS = 30 * 60;
const REST_RESET_SECONDS = 5 * 60;
const ACTIVE_IDLE_LIMIT_SECONDS = 60;
const INTERACTION_COOLDOWN_MS = 8 * 1000;
const INTERACTION_LIFETIME_MS = 5 * 1000;
const WEATHER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SPEECH_START_TIMEOUT_MS = 10 * 1000;
const SPEECH_END_BUFFER_MS = 5 * 1000;
const SPEECH_END_MIN_TIMEOUT_MS = 15 * 1000;
const SPEECH_END_MAX_TIMEOUT_MS = 3 * 60 * 1000;
const SPEECH_END_FALLBACK_TIMEOUT_MS = 60 * 1000;
// Assigned by the main process, not the renderer: reloads must never reuse an
// identifier that an old audio element could still report as ended.
let lastAssignedSpeechToken = 0;
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
  cancelSpeech = () => {},
  rendererReady: initialRendererReady = true,
  getWeatherContext = () => null,
  getBehaviorSettings = () => ({})
}) {
  const triggerStatePath = path.join(app.getPath('userData'), 'trigger-state.json');
  let timer = null;
  let started = false;
  let stopped = false;
  let rendererReady = Boolean(initialRendererReady);
  let speechActive = false;
  let activeSpeechToken = 0;
  let speechPhase = 'idle';
  let speechWatchdog = null;
  let startupTimer = null;
  const resumeTimers = new Set();
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
    const parsed = jsonStore.read(triggerStatePath, {});
    const positiveNumber = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const timestamps = (value) => Object.fromEntries(Object.entries(record(value))
      .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= 0));
    return {
      date: typeof parsed.date === 'string' ? parsed.date : dateKey(),
      autoCount: Math.floor(positiveNumber(parsed.autoCount)),
      lastSpeechAt: positiveNumber(parsed.lastSpeechAt),
      lastInteractionAt: positiveNumber(parsed.lastInteractionAt),
      triggerLastAt: timestamps(parsed.triggerLastAt),
      dialogueLastAt: timestamps(parsed.dialogueLastAt),
      greetedSlots: record(parsed.greetedSlots),
      recentIds: Array.isArray(parsed.recentIds) ? parsed.recentIds.filter((id) => typeof id === 'string').slice(-10) : [],
      weatherSignature: typeof parsed.weatherSignature === 'string' ? parsed.weatherSignature : ''
    };
  }

  function saveTriggerState() {
    try {
      jsonStore.write(triggerStatePath, state);
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
    const interaction = triggerName.startsWith('click_');
    if (interaction) state.lastInteractionAt = now;
    else state.lastSpeechAt = now;
    state.dialogueLastAt[dialogue.id] = now;
    state.recentIds = [...state.recentIds.filter((id) => id !== dialogue.id), dialogue.id].slice(-10);
    if (!manual) {
      if (!interaction) state.autoCount += 1;
      state.triggerLastAt[triggerName] = now;
      if (triggerName.startsWith('time_')) state.greetedSlots[triggerName] = state.date;
    }
    saveTriggerState();
  }

  function dispatch(dialogue, triggerName, manual = false) {
    if (!dialogue || !rendererReady || stopped || speechActive) return false;
    if (lastAssignedSpeechToken >= Number.MAX_SAFE_INTEGER) {
      onRendererUnavailable();
      return false;
    }
    // Reserve the speaking slot before IPC delivery. Without this reservation,
    // two menu clicks in the same event-loop turn can start two audio elements.
    speechActive = true;
    activeSpeechToken = ++lastAssignedSpeechToken;
    speechPhase = 'starting';
    const token = activeSpeechToken;
    armSpeechWatchdog(token, SPEECH_START_TIMEOUT_MS, 'speech-start-timeout');
    try {
      if (sendSpeech({ ...dialogue, triggerName, manual, speechToken: token }) === false) {
        throw new Error('Speech delivery failed');
      }
    } catch (error) {
      console.error('Unable to deliver speech:', error);
      // A failed IPC delivery means the renderer is not known to be usable.
      // Explicit ready notification is required before trying another event.
      onRendererUnavailable();
      return false;
    }
    recordDispatch(dialogue, triggerName, manual);
    return true;
  }

  function clearSpeechSlot() {
    if (speechWatchdog !== null) clearTimeout(speechWatchdog);
    speechWatchdog = null;
    speechActive = false;
    activeSpeechToken = 0;
    speechPhase = 'idle';
  }

  function armSpeechWatchdog(token, timeoutMs, reason) {
    if (speechWatchdog !== null) clearTimeout(speechWatchdog);
    speechWatchdog = setTimeout(() => {
      speechWatchdog = null;
      if (!speechActive || token !== activeSpeechToken) return;
      speechPhase = 'cancelling';
      try {
        // IPC messages from the same sender are ordered. Enqueue cancellation
        // before any replacement speech so recovery cannot create two players.
        if (cancelSpeech(token, reason) === false) throw new Error('Speech cancellation delivery failed');
      } catch (error) {
        console.error('Unable to cancel timed-out speech:', error);
        onRendererUnavailable();
        return;
      }
      clearSpeechSlot();
      flushQueue();
    }, timeoutMs);
  }

  function onRendererUnavailable() {
    rendererReady = false;
    eventQueue = [];
    clearSpeechSlot();
  }

  function onRendererReady() {
    if (stopped) return false;
    rendererReady = true;
    flushQueue();
    return true;
  }

  function validWeatherContext(context, now = Date.now()) {
    if (!context || typeof context.locationId !== 'string' || !context.locationId
      || !Number.isFinite(context.fetchedAt) || context.fetchedAt <= 0) return false;
    const age = now - context.fetchedAt;
    return age <= WEATHER_MAX_AGE_MS && age >= -5 * 60 * 1000;
  }

  function weatherTriggers(context) {
    if (!validWeatherContext(context)) return [];
    const present = new Set([`weather_${context.state}`]);
    if (context.hot) present.add('weather_hot');
    if (context.cold) present.add('weather_cold');
    if (context.windy) present.add('weather_windy');
    return [
      'weather_thunder', 'weather_heavy_rain', 'weather_snow',
      'weather_hot', 'weather_cold', 'weather_windy',
      'weather_rain', 'weather_cloudy', 'weather_clear'
    ].filter((triggerName) => present.has(triggerName));
  }

  function weatherTriggerName(context, manual = false) {
    return weatherTriggers(context).find((triggerName) => weatherAllowed(triggerName, manual)) || null;
  }

  function weatherSummary(context) {
    const temperature = Number.isFinite(context.temperature)
      ? `${Math.round(context.temperature)}℃`
      : '';
    const apparent = Number.isFinite(context.apparentTemperature)
      ? `，体感${Math.round(context.apparentTemperature)}℃`
      : '';
    const conditions = [context.hot && '高温', context.cold && '低温', context.windy && '大风'].filter(Boolean);
    const combined = conditions.length ? `（${conditions.join('、')}）` : '';
    return `${context.city}：${context.label}${temperature ? `，${temperature}` : ''}${apparent}${combined}。`;
  }

  function prepareDialogue(dialogue, triggerName, context = getWeatherContext()) {
    if (!dialogue) return null;
    if (!triggerName.startsWith('weather_')) return dialogue;
    if (!validWeatherContext(context)) return null;
    const raw = dialogues.find((item) => item.id === dialogue.id) || dialogue;
    return {
      ...raw,
      translation: `${weatherSummary(context)}${raw.translation || ''}`,
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
    if (!dialogue || !rendererReady || stopped) return false;
    const weather = triggerName.startsWith('weather_');
    const context = weather ? getWeatherContext() : null;
    if (weather && !validWeatherContext(context)) return false;
    const now = Date.now();
    const interaction = triggerName.startsWith('click_');
    const event = {
      dialogue,
      triggerName,
      manual: Boolean(options.manual),
      bypassCooldown: Boolean(options.bypassCooldown),
      ...(weather ? { weatherLocationId: context.locationId } : {}),
      ...(interaction ? { expiresAt: now + INTERACTION_LIFETIME_MS } : {}),
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
    if (!options.force && userInteraction && now - state.lastInteractionAt < INTERACTION_COOLDOWN_MS) return false;
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
    if (!selectedDialogue) return false;
    return queueDialogue(selectedDialogue, triggerName, {
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
    const triggerName = weatherTriggerName(context, true);
    if (!triggerName) return false;
    const selectedDialogue = selectDialogue(triggerName, Date.now(), true, true);
    return queueDialogue(selectedDialogue, triggerName, {
      manual: true,
      bypassCooldown: true
    });
  }

  function handleWeatherUpdate(nextContext, previousContext, meta = {}) {
    const invalid = !validWeatherContext(nextContext);
    const locationChanged = meta.reason === 'location-changed'
      || (previousContext && nextContext && previousContext.locationId !== nextContext.locationId);
    eventQueue = eventQueue.filter((event) => !event.triggerName.startsWith('weather_') || (
      !invalid && !locationChanged && meta.reason !== 'disabled'
      && event.weatherLocationId === nextContext.locationId
      && event.triggerName === weatherTriggerName(nextContext, event.manual)
    ));
    const previousSignature = state.weatherSignature;
    state.weatherSignature = invalid ? '' : nextContext.signature;
    saveTriggerState();
    if (invalid || locationChanged || meta.reason === 'disabled' || meta.reason === 'refresh-failed'
      || !previousContext || !previousSignature || previousSignature === nextContext.signature) {
      flushQueue();
      return false;
    }
    const becameImportant = nextContext.severe
      || nextContext.state === 'snow'
      || nextContext.state === 'rain'
      || nextContext.hot
      || nextContext.cold
      || nextContext.windy;
    const triggerName = weatherTriggerName(nextContext);
    const requested = Boolean(becameImportant && triggerName && requestTrigger(triggerName));
    flushQueue();
    return requested;
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
    if (!eventQueue.length) return false;
    const now = Date.now();
    const { settings, profile } = currentBehavior();
    const context = getWeatherContext();
    eventQueue = eventQueue.filter((event) => {
      const userEvent = event.manual || event.family === 'interaction';
      if (!userEvent && (!settings.proactiveEnabled || state.autoCount >= profile.dailyLimit)) return false;
      if (!event.triggerName.startsWith('weather_')) return true;
      return validWeatherContext(context, now) && event.weatherLocationId === context.locationId
        && event.triggerName === weatherTriggerName(context, event.manual);
    });
    if (speechActive || !rendererReady || stopped) return false;
    // A quiet-time or cooling-down reminder must not hide a permitted click or
    // explicit menu request behind it. The queue is already priority ordered.
    const index = eventQueue.findIndex((event) => {
      const interaction = event.family === 'interaction';
      if (event.manual) return true;
      if (interaction) {
        return event.bypassCooldown || (now - state.lastInteractionAt >= INTERACTION_COOLDOWN_MS
          && now - (state.triggerLastAt[event.triggerName] || 0) >= TRIGGER_COOLDOWNS_MS[event.triggerName]);
      }
      if (isQuietTime(new Date(now), settings)) return false;
      return event.bypassCooldown || now - state.lastSpeechAt >= profile.globalCooldownSeconds * 1000;
    });
    if (index < 0) return false;
    const [next] = eventQueue.splice(index, 1);
    const dialogue = prepareDialogue(next.dialogue, next.triggerName, context);
    return dispatch(dialogue, next.triggerName, next.manual);
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
    if (!started) return;
    const resumeTimer = setTimeout(() => {
      resumeTimers.delete(resumeTimer);
      if (started) requestTrigger('system_resume');
    }, 3000);
    resumeTimers.add(resumeTimer);
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    lastTickAt = Date.now();
    timer = setInterval(tick, 15 * 1000);
    powerMonitor.on('resume', scheduleResumeTrigger);
    powerMonitor.on('unlock-screen', scheduleResumeTrigger);
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (!started) return;
      const triggerName = getClockContext().scheduledTrigger;
      if (triggerName) requestTrigger(triggerName);
    }, 8 * 1000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (startupTimer !== null) clearTimeout(startupTimer);
    startupTimer = null;
    for (const resumeTimer of resumeTimers) clearTimeout(resumeTimer);
    resumeTimers.clear();
    clearSpeechSlot();
    eventQueue = [];
    powerMonitor.removeListener('resume', scheduleResumeTrigger);
    powerMonitor.removeListener('unlock-screen', scheduleResumeTrigger);
    started = false;
    stopped = true;
  }

  function onSpeechStarted(payload) {
    const token = payload?.token;
    if (!Number.isSafeInteger(token) || token <= 0 || token !== activeSpeechToken
      || !speechActive || speechPhase !== 'starting' || !rendererReady || stopped) return false;
    speechPhase = 'playing';
    const durationMs = payload?.durationMs;
    const timeoutMs = Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(SPEECH_END_MAX_TIMEOUT_MS, Math.max(SPEECH_END_MIN_TIMEOUT_MS, durationMs + SPEECH_END_BUFFER_MS))
      : SPEECH_END_FALLBACK_TIMEOUT_MS;
    armSpeechWatchdog(token, timeoutMs, 'speech-end-timeout');
    return true;
  }

  function onSpeechEnded(token) {
    if (!Number.isSafeInteger(token) || token <= 0 || token !== activeSpeechToken
      || !speechActive || speechPhase === 'cancelling') return false;
    clearSpeechSlot();
    flushQueue();
    return true;
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
    onRendererUnavailable,
    onRendererReady,
    onSettingsChanged,
    getDebugState: () => ({
      ...state,
      speechActive,
      activeSpeechToken,
      speechPhase,
      rendererReady,
      activeWorkMs,
      eventQueue
    })
  };
}

module.exports = {
  createTriggerEngine,
  getClockContext
};
