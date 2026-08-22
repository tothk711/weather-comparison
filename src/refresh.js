'use strict';
// The scheduled/manual "refresh everything" path.
//
// v2.0's POST /api/fetch ran 8 cities × 2 upstream endpoints on ANY
// unauthenticated POST, with no in-flight guard: repeated clicks or a trivial
// curl loop stacked overlapping runs. Concurrent runs for one city also raced
// the freeze invariant — both read the old cache, both overlaid, last write
// won, and frozen past values could be LOST. Now there is exactly one run at a
// time, a minimum interval between runs, and an optional token.

const { config } = require('./config');
const logger = require('./logger');
const store = require('./weather/store');
const { clearMedian } = require('./weather/median');
const verify = require('./features/verify');
const crosscheck = require('./features/crosscheck');
const market = require('./features/market');
const future = require('./features/future');

let running = null;
let lastRunAt = 0;
let lastResult = null;

async function refreshAll(reason = 'manual') {
  if (running) {
    logger.debug('refresh already in progress — joining', { reason });
    return running;
  }
  running = (async () => {
    const started = Date.now();
    logger.info('refresh started', { reason, cities: config.cities.length });
    const results = await Promise.allSettled(config.cities.map(c => store.fetchAndCache(c)));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - ok;

    // The underlying data changed, so anything derived from it is now stale.
    // (v2.0 also cleared the market cache here, which a weather refresh does
    // not invalidate — market has its own upstream calls. It is cleared anyway
    // because a manual refresh should mean "give me everything fresh".)
    clearMedian();
    verify.clear();
    crosscheck.clear();
    future.clear();
    if (reason === 'manual') market.clear();

    lastRunAt = Date.now();
    lastResult = { reason, ok, failed, durationMs: lastRunAt - started, at: new Date(lastRunAt).toISOString() };
    logger[failed ? 'warn' : 'info']('refresh finished', lastResult);
    return lastResult;
  })().finally(() => { running = null; });
  return running;
}

function refreshStatus() {
  return {
    running: !!running,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastResult,
    minIntervalMs: config.security.fetchMinIntervalMs,
  };
}

function throttled() {
  return !running && lastRunAt && (Date.now() - lastRunAt) < config.security.fetchMinIntervalMs;
}

module.exports = { refreshAll, refreshStatus, throttled, isRunning: () => !!running };
