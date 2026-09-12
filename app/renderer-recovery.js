'use strict';

function createRendererRecovery({ pause, resume, reload, exhausted,
  setTimer = setTimeout, clearTimer = clearTimeout,
  startupTimeoutMs = 20000, stableMs = 60000, maxAttempts = 3 }) {
  let startupTimer = null;
  let retryTimer = null;
  let stableTimer = null;
  let attempts = 0;
  let disposed = false;
  let state = 'loading';

  function clear(name) {
    if (name === 'startup') { clearTimer(startupTimer); startupTimer = null; }
    if (name === 'retry') { clearTimer(retryTimer); retryTimer = null; }
    if (name === 'stable') { clearTimer(stableTimer); stableTimer = null; }
  }
  function loading() {
    if (disposed) return;
    clear('startup'); clear('stable');
    state = 'loading';
    pause();
    startupTimer = setTimer(() => failed('模型加载超时'), startupTimeoutMs);
  }
  function failed(reason = '渲染中断') {
    if (disposed || retryTimer || state === 'failed') return;
    clear('startup'); clear('stable');
    pause();
    if (attempts >= maxAttempts) {
      state = 'failed';
      exhausted(reason);
      return;
    }
    state = 'recovering';
    const delay = 1000 * (2 ** attempts++);
    retryTimer = setTimer(() => {
      retryTimer = null;
      loading();
      try { reload(); } catch (error) { failed(error.message); }
    }, delay);
  }
  function ready() {
    if (disposed || state === 'failed') return false;
    clear('startup'); clear('retry'); clear('stable');
    state = 'ready';
    resume();
    stableTimer = setTimer(() => { attempts = 0; stableTimer = null; }, stableMs);
    return true;
  }
  function retry() {
    if (disposed) return;
    clear('retry');
    attempts = 0;
    state = 'loading';
    loading();
    try { reload(); } catch (error) { failed(error.message); }
  }
  function dispose() {
    disposed = true;
    clear('startup'); clear('retry'); clear('stable');
  }
  return { loading, failed, ready, retry, dispose, getState: () => state };
}

module.exports = { createRendererRecovery };
