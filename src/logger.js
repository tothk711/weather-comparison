'use strict';
// Small structured logger. v2.0 had 57 raw console.* calls and no way to tell
// a cache miss from an upstream failure in production — which is exactly why
// the caching bugs in the audit could run undetected for months.

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] || LEVELS.info;
const asJson = config.logFormat === 'json';

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  if (asJson) {
    const line = JSON.stringify({ time, level, msg, ...(fields || {}) });
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    return;
  }
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const extra = fields && Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
    : '';
  (level === 'error' || level === 'warn' ? console.error : console.log)(
    `${time.slice(11, 19)} ${tag} ${msg}${extra}`);
}

const logger = {
  debug: (m, f) => emit('debug', m, f),
  info:  (m, f) => emit('info', m, f),
  warn:  (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
  child: (base) => ({
    debug: (m, f) => emit('debug', m, { ...base, ...f }),
    info:  (m, f) => emit('info', m, { ...base, ...f }),
    warn:  (m, f) => emit('warn', m, { ...base, ...f }),
    error: (m, f) => emit('error', m, { ...base, ...f }),
  }),
};

module.exports = logger;
