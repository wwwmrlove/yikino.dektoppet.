'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');

// GUI applications can outlive the terminal/launcher that owns their pipes.
// Contain only logging/stream failures, never unrelated application exceptions.
function installSafeLogging({ logFile, consoleObject = console,
  stdout = process.stdout, stderr = process.stderr, fileSystem = fs, maxBytes = 1024 * 1024 }) {
  const broken = new Set();
  const originals = new Map();
  const listeners = new Map();
  const isClosedPipe = error => error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';

  function record(level, args) {
    if (!logFile) return;
    try {
      fileSystem.mkdirSync(path.dirname(logFile), {recursive: true});
      let size = 0;
      try { size = fileSystem.statSync(logFile).size; } catch { /* first log */ }
      if (size >= maxBytes) fileSystem.renameSync(logFile, `${logFile}.previous`);
      // Cap single messages as well as the retained file, including error stacks.
      const message = format(...args).slice(0, 16 * 1024);
      fileSystem.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
    } catch { /* Diagnostics must not become an application failure. */ }
  }

  for (const stream of new Set([stdout, stderr])) {
    if (!stream?.on) continue;
    const onError = error => {
      if (!isClosedPipe(error)) throw error;
      broken.add(stream);
      record('warn', ['Launcher output disconnected; logging continues in this file.', error.code]);
    };
    listeners.set(stream, onError);
    stream.on('error', onError);
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    if (typeof consoleObject[level] !== 'function') continue;
    const original = consoleObject[level];
    originals.set(level, original);
    consoleObject[level] = (...args) => {
      record(level, args);
      const stream = level === 'warn' || level === 'error' ? stderr : stdout;
      if (broken.has(stream)) return;
      try { original.apply(consoleObject, args); }
      catch (error) {
        if (!isClosedPipe(error)) throw error;
        broken.add(stream);
      }
    };
  }

  return { dispose() {
    for (const [level, original] of originals) consoleObject[level] = original;
    for (const [stream, listener] of listeners) stream.removeListener('error', listener);
  } };
}

module.exports = { installSafeLogging };
