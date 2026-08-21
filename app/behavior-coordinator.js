'use strict';

const MAX_QUEUE_LENGTH = 8;

function eventFamily(triggerName, manual = false) {
  if (manual) return 'manual';
  if (triggerName.startsWith('weather_')) return 'weather';
  if (triggerName.startsWith('time_') || triggerName.startsWith('clock_')) return 'time';
  if (triggerName.startsWith('continuous_work_')) return 'work';
  if (triggerName.startsWith('return_') || triggerName === 'system_resume') return 'return';
  if (triggerName.startsWith('click_')) return 'interaction';
  if (triggerName === 'random_dialogue') return 'random';
  return 'other';
}

function eventLifetimeMs(family, priority) {
  if (family === 'manual') return 5 * 60 * 1000;
  if (priority >= 80) return 8 * 60 * 1000;
  if (family === 'time') return 20 * 60 * 1000;
  if (family === 'work' || family === 'return') return 15 * 60 * 1000;
  return 8 * 60 * 1000;
}

function normalizeEvent(event, now = Date.now()) {
  const priority = Math.max(0, Number(event.priority) || 0);
  const family = event.family || eventFamily(event.triggerName, event.manual);
  return {
    ...event,
    family,
    priority,
    queuedAt: Number(event.queuedAt) || now,
    expiresAt: Number(event.expiresAt) || now + eventLifetimeMs(family, priority)
  };
}

function pruneExpired(queue, now = Date.now()) {
  return queue.filter((event) => event.expiresAt > now);
}

function coordinateQueue(queue, incoming, now = Date.now()) {
  const event = normalizeEvent(incoming, now);
  let next = pruneExpired(queue, now);

  // A family represents one current intention. Keep only its newest, most useful
  // event so weather changes, click bursts, or repeated timers cannot pile up.
  const sameFamily = next.filter((item) => item.family === event.family);
  if (sameFamily.length) {
    const strongest = sameFamily.reduce((best, item) => (
      item.priority > best.priority ? item : best
    ));
    if (strongest.priority > event.priority && event.family !== 'manual') return next;
    next = next.filter((item) => item.family !== event.family);
  }

  // Urgent information absorbs low-value chatter and scheduled greetings. Work
  // and return reminders remain queued and will be delivered after the cooldown.
  if (event.priority >= 70) {
    next = next.filter((item) => !['random', 'time'].includes(item.family));
  }
  if (['weather', 'work', 'return'].includes(event.family)) {
    next = next.filter((item) => item.family !== 'random');
  }

  next.push(event);
  next.sort((left, right) => (
    right.priority - left.priority || left.queuedAt - right.queuedAt
  ));
  return next.slice(0, MAX_QUEUE_LENGTH);
}

function takeNextEvent(queue, now = Date.now()) {
  const current = pruneExpired(queue, now);
  if (!current.length) return { event: null, queue: current };
  const [event, ...remaining] = current;
  return { event, queue: remaining };
}

module.exports = {
  eventFamily,
  coordinateQueue,
  takeNextEvent,
  pruneExpired
};
