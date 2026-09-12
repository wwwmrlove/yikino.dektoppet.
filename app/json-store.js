'use strict';

const path = require('path');
let sequence = 0;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createJsonStore(fs) {
  function parse(file) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(value)) throw new TypeError('Settings must be a JSON object');
    return value;
  }
  function read(file, fallback = {}) {
    for (const candidate of [file, `${file}.bak`]) {
      try { return parse(candidate); } catch { /* try the last valid snapshot */ }
    }
    return fallback;
  }
  function replace(file, text) {
    const temporary = `${file}.tmp-${process.pid}-${++sequence}`;
    try {
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
  }
  function write(file, value) {
    if (!isPlainObject(value)) throw new TypeError('Settings must be a JSON object');
    const text = JSON.stringify(value, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let previous;
    try { previous = parse(file); } catch { /* keep any valid existing backup */ }
    if (previous) replace(`${file}.bak`, JSON.stringify(previous, null, 2));
    replace(file, text);
  }
  return { read, write };
}

module.exports = { createJsonStore };
