'use strict';
// ---------------------------------------------------------------------------
// Zephyr Weather — entry point.
//
// v3.0 split the old 2,000-line single file into src/. This file now does one
// job: validate the configuration, start the database, schedule the refresh,
// and listen. The bottom re-exports the pure helpers so tests (and anything
// that used to require('./server')) keep working.
// ---------------------------------------------------------------------------

const cron = require('node-cron');
const { config, validate } = require('./src/config');
const logger = require('./src/logger');
const db = require('./src/db');
const { createApp } = require('./src/app');
const refresh = require('./src/refresh');

async function start() {
  const { warnings, errors } = validate();
  warnings.forEach(w => logger.warn(w));
  if (errors.length) {
    errors.forEach(e => logger.error(e));
    throw new Error(`Configuration is invalid (${errors.length} error(s)) — refusing to start.`);
  }

  logger.info(`${config.app.name} ${config.app.version} starting`, {
    port: config.app.port,
    timezone: config.app.timezone,
    nodeTz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    db: config.db.enabled ? 'configured' : 'memory-only',
  });

  await db.init();

  // The cron schedule is pinned to the app timezone. v2.0 passed no timezone,
  // so the refresh followed the container's clock (UTC on Railway) while every
  // piece of data maths was pinned to Europe/Prague.
  const task = cron.schedule(config.app.refreshCron, () => {
    refresh.refreshAll('cron').catch(err => logger.error('scheduled refresh failed', { err: err.message }));
  }, { timezone: config.app.timezone });

  // Warm the cache, but never block the port on it: if Open-Meteo is down at
  // boot the app must still come up and serve whatever it has.
  refresh.refreshAll('startup').catch(err => logger.error('startup refresh failed', { err: err.message }));

  const app = createApp();
  const server = app.listen(config.app.port, () => {
    logger.info(`${config.app.name} listening`, { port: config.app.port });
  });

  const shutdown = signal => {
    logger.info('shutting down', { signal });
    if (task && task.stop) task.stop();
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Node 20+ terminates the process on an unhandled rejection. v2.0 had no
// handler at all, so one unlucky upstream error could take the dashboard down.
process.on('unhandledRejection', err => {
  logger.error('unhandled rejection (suppressed)', { err: err && err.message ? err.message : String(err) });
});
process.on('uncaughtException', err => {
  logger.error('uncaught exception — exiting', { err: err.message, stack: err.stack });
  process.exit(1);
});

if (require.main === module) {
  start().catch(err => {
    logger.error('failed to start', { err: err.message });
    process.exit(1);
  });
}

// --- public surface (pure helpers; used by tests and any external caller) ----
const dates = require('./src/lib/dates');
const stats = require('./src/lib/stats');
const parse = require('./src/weather/parse');
const revisions = require('./src/weather/revisions');
const codes = require('./src/features/weather-codes');
const verify = require('./src/features/verify');
const crosscheck = require('./src/features/crosscheck');
const future = require('./src/features/future');
const live = require('./src/features/live');
const market = require('./src/features/market');
const weekly = require('./src/features/weekly');

module.exports = {
  start, createApp, config,

  // dates
  getDateString: dates.getDateString, addDays: dates.addDays, daysBetween: dates.daysBetween,
  isoWeekOf: dates.isoWeekOf, isoWeekDates: dates.isoWeekDates, isoWeeksInYear: dates.isoWeeksInYear,
  shiftIsoWeek: dates.shiftIsoWeek, nowInTz: dates.nowInTz, localHourIndex: dates.localHourIndex,
  APP_TIMEZONE: config.app.timezone,

  // stats
  medianOf: stats.medianOf, medianSeries: stats.medianSeries, haversineKm: stats.haversineKm,

  // weather
  parseWeatherPayload: parse.parseWeatherPayload, computePastAvg: parse.computePastAvg,
  freezePastDays: parse.freezePastDays, hasCurrentDayLabels: parse.hasCurrentDayLabels,
  computeRevisions: revisions.computeRevisions, reviseDay: revisions.reviseDay,

  // weather codes / classifiers
  describeWeather: codes.describeWeather, weatherIcon: codes.weatherIcon,
  classifyPressure: codes.classifyPressure, classifyWind: codes.classifyWind,
  classifyClouds: codes.classifyClouds,

  // features
  runDataChecks: verify.runDataChecks,
  analyzeCrossCheck: crosscheck.analyzeCrossCheck, seriesToDays: crosscheck.seriesToDays,
  parseFuture: future.parseFuture, buildNotes: future.buildNotes, applyMedianTemps: future.applyMedianTemps,
  parseLive: live.parseLive, liveDir: live.liveDir,
  parseMarketCity: market.parseMarketCity, buildMarketBrief: market.buildMarketBrief,
  windPowerAt: market.windPowerAt, windPowerIndex: market.windPowerIndex,
  solarIndex: market.solarIndex, degreeDays: market.degreeDays, signalDir: market.signalDir,
  residualLoad: market.residualLoad,
  buildWeeklyTable: weekly.buildWeeklyTable, weekOptions: weekly.weekOptions,

  // config surfaces the old tests referenced
  VERIFY: config.verify, CROSSCHECK: config.crosscheck, MARKET: config.market,
  HISTORY: { SOURCES: config.models }, MEDIAN_MODELS: config.modelIds,
  FREEZE_PAST: config.weather.freezePast,

  // back-compat aliases for v2.0 names
  parsePreparation: future.parseFuture,
  buildHistoryTable: weekly.buildWeeklyTable,
};
