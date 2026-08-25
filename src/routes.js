'use strict';
// Every HTTP route, in one place. v2.0 split them across two non-contiguous
// blocks 400 lines apart.
//
// Two structural fixes from the audit:
//  * Express 4 does not catch rejected async handlers, and there was no error
//    middleware — a throw in /api/weather left the request hanging until the
//    client timed out. Every handler is now wrapped in `wrap()`, and app.js
//    mounts a real error handler behind it.
//  * /api/status was the only route that did not degrade without Postgres.

const express = require('express');
const { config } = require('./config');
const logger = require('./logger');
const db = require('./db');
const { allCacheStats } = require('./lib/cache');
const { upstreamMetrics } = require('./lib/openmeteo');

const store = require('./weather/store');
const { getSeries, normaliseSource } = require('./weather');
const { computeRevisions } = require('./weather/revisions');
const { medianStats } = require('./weather/median');
const verify = require('./features/verify');
const crosscheck = require('./features/crosscheck');
const future = require('./features/future');
const live = require('./features/live');
const observed = require('./features/observed');
const market = require('./features/market');
const weekly = require('./features/weekly');
const refresh = require('./refresh');

// Express 4 swallows rejected async handlers. This is the seatbelt.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Resolve :city against the whitelist, or answer 404 and stop.
function resolveCity(req, res) {
  const city = store.cityByName(req.params.city);
  if (!city) { res.status(404).json({ error: 'City not found' }); return null; }
  return city;
}

const router = express.Router();

// ---- meta -------------------------------------------------------------------

router.get('/cities', (req, res) => {
  res.json(config.cities.map(c => c.name));
});

router.get('/config', (req, res) => {
  res.json({
    app: { name: config.app.name, version: config.app.version, timezone: config.app.timezone },
    cities: config.cities.map(c => ({ name: c.name, country: c.country })),
    models: config.models,
    countries: config.future.COUNTRIES.map(c => ({ code: c.code, name: c.name, capital: c.capital })),
    live: config.live.CITIES,
    weekly: weekly.weekOptions(),
    defaultSource: 'median',
  });
});

// Liveness/readiness plus the cache and upstream counters that make the
// caching bugs in the audit visible instead of silent.
router.get('/health', wrap(async (req, res) => {
  res.json({
    status: 'ok',
    name: config.app.name,
    version: config.app.version,
    uptimeSec: Math.round(process.uptime()),
    timezone: config.app.timezone,
    nodeTz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    db: db.status(),
    store: store.storeStats(),
    median: medianStats(),
    caches: allCacheStats(),
    upstream: upstreamMetrics(),
    refresh: refresh.refreshStatus(),
  });
}));

// Per-city cache timestamps. Works with Postgres down (v2.0 returned a 500).
router.get('/status', wrap(async (req, res) => {
  res.json({
    cities: await store.statusRows(),
    totalCities: config.cities.length,
    db: db.status(),
  });
}));

// ---- weather ----------------------------------------------------------------

router.get('/weather/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  const entry = await getSeries(city, req.query.source);
  res.json({ ...entry.data, _source: entry.source });
}));

router.get('/revisions/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  const entry = await getSeries(city, req.query.source);
  res.json({
    city: city.name, source: entry.source, generatedAt: new Date().toISOString(),
    note: "positive = warmer than yesterday's run",
    ...computeRevisions(entry.data),
  });
}));

router.get('/verify/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  res.json(await verify.verifyCity(city, req.query.source));
}));

router.get('/crosscheck/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  res.json(await crosscheck.crossCheckCity(city, req.query.source));
}));

// ---- future (CZ + HU in one tab) -------------------------------------------

router.get('/future', wrap(async (req, res) => {
  res.json(await future.fetchAll(req.query.source));
}));

router.get('/future/:country', wrap(async (req, res) => {
  const code = String(req.params.country || '').toUpperCase();
  const country = config.future.COUNTRIES.find(c => c.code === code);
  if (!country) return res.status(404).json({ error: 'Unknown country — use CZ or HU' });
  res.json(await future.fetchCountry(country, req.query.source));
}));

// Back-compat with v2.0's /api/preparation/:city (Prague | Budapest).
router.get('/preparation/:city', wrap(async (req, res) => {
  const country = config.future.COUNTRIES.find(c => c.capital === req.params.city);
  if (!country) return res.status(404).json({ error: 'City not found' });
  res.json(await future.fetchCountry(country, req.query.source));
}));

// ---- live -------------------------------------------------------------------

router.get('/live/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  res.json(await live.fetchLive(city));
}));

// ---- observed (airport METAR stations) --------------------------------------

router.get('/observed/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  res.json(await observed.getObserved(city));
}));

// ---- market -----------------------------------------------------------------

// One call for the whole tab: both countries plus the forecast-stability inputs
// the cards show. v2.0's Market tab made five separate requests per render.
router.get('/market', wrap(async (req, res) => {
  const codes = Object.keys(config.market.COUNTRIES);
  const briefs = await Promise.all(codes.map(async code => {
    const brief = await market.marketBrief(code).catch(err => {
      logger.warn('market brief failed', { code, err: err.message });
      return null;
    });
    if (!brief) return null;
    const capital = store.cityByName(config.future.COUNTRIES.find(c => c.code === code).capital);
    const [rev, cc] = await Promise.all([
      getSeries(capital, req.query.source).then(e => computeRevisions(e.data)).catch(() => null),
      crosscheck.crossCheckCity(capital, req.query.source).catch(() => null),
    ]);
    return {
      ...brief,
      stability: {
        capital: capital.name,
        revision: rev,
        modelSpread: {
          today: cc ? cc.meanSpread : null,
          tomorrow: cc && cc.tomorrow ? cc.tomorrow.meanSpread : null,
        },
        correctedHours: cc ? (cc.correctedHours || []).length : null,
        suspectHours: cc ? (cc.suspectHours || []).length : null,
      },
    };
  }));
  const countries = briefs.filter(Boolean);
  if (!countries.length) return res.status(502).json({ error: 'Could not build the market brief' });
  res.json({ generatedAt: new Date().toISOString(), countries });
}));

router.get('/market/:country', wrap(async (req, res) => {
  const code = String(req.params.country || '').toUpperCase();
  if (!config.market.COUNTRIES[code]) {
    return res.status(404).json({ error: 'Unknown country — use CZ or HU' });
  }
  res.json(await market.marketBrief(code));
}));

// ---- weekly (was History) ---------------------------------------------------

router.get('/weekly/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  const source = normaliseSource(req.query.source);

  const opts = weekly.weekOptions(weekly.tzForCity(city.name));
  const week = parseInt(req.query.week, 10);
  // The year is explicit now, so December can be read from January.
  const year = req.query.year !== undefined ? parseInt(req.query.year, 10) : opts.current.year;
  if (!Number.isInteger(week) || !Number.isInteger(year)) {
    return res.status(400).json({ error: 'week and year must be integers' });
  }
  const allowed = opts.weeks.some(w => w.year === year && w.week === week);
  if (!allowed) {
    const first = opts.weeks[0], last = opts.weeks[opts.weeks.length - 1];
    return res.status(400).json({
      error: `week ${year}-W${week} is outside the selectable range ` +
             `(${first.year}-W${first.week} … ${last.year}-W${last.week})`,
    });
  }
  res.json(await weekly.fetchWeekly(city, year, week, source));
}));

// Back-compat with v2.0's /api/history/:city?week=N (current ISO year only).
router.get('/history/:city', wrap(async (req, res) => {
  const city = resolveCity(req, res);
  if (!city) return;
  const source = normaliseSource(req.query.source);
  const opts = weekly.weekOptions(weekly.tzForCity(city.name));
  const week = parseInt(req.query.week, 10);
  if (!Number.isInteger(week)) return res.status(400).json({ error: 'week must be an integer' });
  res.json(await weekly.fetchWeekly(city, opts.current.year, week, source));
}));

// ---- refresh ----------------------------------------------------------------

router.post('/fetch', wrap(async (req, res) => {
  if (config.security.fetchToken) {
    const given = req.get('x-fetch-token') || req.query.token;
    if (given !== config.security.fetchToken) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (refresh.throttled()) {
    const status = refresh.refreshStatus();
    return res.status(429).json({
      error: 'Refresh throttled — the data was just refreshed',
      retryAfterMs: config.security.fetchMinIntervalMs - (Date.now() - new Date(status.lastRunAt).getTime()),
      lastResult: status.lastResult,
    });
  }
  const result = await refresh.refreshAll('manual');
  res.json({ success: true, ...result });
}));

module.exports = router;
