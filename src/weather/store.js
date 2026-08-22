'use strict';
// ---------------------------------------------------------------------------
// The canonical (best_match) weather store: memory + Postgres.
//
// Bugs from the audit fixed here:
//
//  * Silent memory/DB divergence. v2.0 wrote memory first, then Postgres, and
//    SWALLOWED the DB error. Reads preferred the DB row and only fell back to
//    memory when the READ failed — so after any write failure the DB kept
//    returning the old row forever, memory's fresh copy was never consulted,
//    and the 1-hour check refetched on EVERY request. Now the write result is
//    tracked and reads take whichever copy is actually newer.
//
//  * No request coalescing. /api/weather/:city fired one upstream request per
//    concurrent caller. The dashboard asks for four Czech cities at once, and a
//    cold start can overlap with the boot fetch and the cron run.
//
//  * Stale day labels. Freshness is now age AND correct day labels — see
//    hasCurrentDayLabels().
// ---------------------------------------------------------------------------

const db = require('../db');
const logger = require('../logger');
const { config } = require('../config');
const { fetchJson } = require('../lib/openmeteo');
const { parseWeatherPayload, freezePastDays, hasCurrentDayLabels } = require('./parse');

// { cityName: { data, updatedAt: Date, dbSynced: boolean } }
const memory = new Map();
const inFlight = new Map();
const stats = { fetches: 0, coalesced: 0, dbWriteFailures: 0, dbReadFailures: 0, frozenValues: 0 };

const TZ = config.app.timezone;

// One city, best_match model: current forecast + yesterday's run, in parallel.
async function fetchFromApi(city) {
  const common = {
    latitude: city.lat, longitude: city.lon,
    hourly: 'temperature_2m', timezone: TZ,
  };
  const [data, prevData] = await Promise.all([
    fetchJson('forecast', { ...common, past_days: 8, forecast_days: 3 }, { label: `forecast ${city.name}` }),
    // Yesterday's run is a bonus, never a hard requirement.
    fetchJson('previousRuns', {
      latitude: city.lat, longitude: city.lon,
      hourly: 'temperature_2m_previous_day1', forecast_days: 3, timezone: TZ,
    }, { label: `previous-runs ${city.name}` }).catch(err => {
      logger.debug('previous-runs unavailable', { city: city.name, err: err.message });
      return null;
    }),
  ]);
  if (!data.hourly || !Array.isArray(data.hourly.time) || !Array.isArray(data.hourly.temperature_2m)) {
    throw new Error('no hourly data in response');
  }
  return parseWeatherPayload(data, prevData);
}

async function writeThrough(cityName, data) {
  const updatedAt = new Date();
  memory.set(cityName, { data, updatedAt, dbSynced: false });
  if (!db.isReady()) return;
  try {
    await db.query(`
      INSERT INTO weather_cache (city_name, data, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (city_name)
      DO UPDATE SET data = $2, updated_at = $3
    `, [cityName, JSON.stringify(data), updatedAt]);
    const entry = memory.get(cityName);
    if (entry && entry.updatedAt === updatedAt) entry.dbSynced = true;
  } catch (err) {
    stats.dbWriteFailures++;
    // Loud, and countable in /api/health — the v2.0 version was one console.error.
    logger.error('cache write to postgres failed; memory copy is now authoritative', {
      city: cityName, err: err.message,
    });
  }
}

// Read the newest of (memory, database). v2.0 blindly preferred the DB row.
async function read(cityName) {
  const mem = memory.get(cityName) || null;
  let row = null;
  if (db.isReady()) {
    try {
      const result = await db.query(
        'SELECT data, updated_at FROM weather_cache WHERE city_name = $1', [cityName]);
      if (result.rows.length) {
        row = { data: result.rows[0].data, updatedAt: new Date(result.rows[0].updated_at) };
      }
    } catch (err) {
      stats.dbReadFailures++;
      logger.warn('cache read from postgres failed; using memory', { city: cityName, err: err.message });
    }
  }
  if (mem && row) return mem.updatedAt >= row.updatedAt ? mem : row;
  return mem || row;
}

// Fresh means: recent enough AND still labelled for the current day.
function isFresh(entry) {
  if (!entry || !entry.data) return false;
  if (!hasCurrentDayLabels(entry.data)) return false;
  return (Date.now() - new Date(entry.updatedAt).getTime()) < config.weather.cacheMs;
}

// Fetch fresh data, overlay frozen history from the existing cache, store it.
// Coalesced per city: concurrent callers share ONE upstream round trip.
function fetchAndCache(city) {
  const key = city.name;
  if (inFlight.has(key)) { stats.coalesced++; return inFlight.get(key); }
  const p = (async () => {
    stats.fetches++;
    const fresh = await fetchFromApi(city);
    const old = await read(key);
    const overridden = freezePastDays(fresh, old && old.data);
    if (overridden > 0) {
      stats.frozenValues += overridden;
      logger.debug('frozen history preserved', { city: key, values: overridden });
    }
    await writeThrough(key, fresh);
    return fresh;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// The read path used by every route: cached when usable, refetched when not,
// and last-known-good rather than an error when the upstream is down.
async function getWeather(city) {
  const cached = await read(city.name);
  if (isFresh(cached)) return cached;
  try {
    const data = await fetchAndCache(city);
    return { data, updatedAt: new Date() };
  } catch (err) {
    // Only serve stale data whose day labels are still correct — a payload
    // labelled for yesterday is worse than an honest failure.
    if (cached && hasCurrentDayLabels(cached.data)) {
      logger.warn('weather fetch failed, serving stale cache', { city: city.name, err: err.message });
      return cached;
    }
    throw err;
  }
}

function cityByName(name) {
  return config.cities.find(c => c.name === name) || null;
}

function storeStats() {
  return {
    ...stats,
    memoryEntries: memory.size,
    unsyncedToDb: [...memory.values()].filter(e => !e.dbSynced).length,
  };
}

// Cache timestamps for every city, without touching the network.
async function statusRows() {
  const rows = [];
  for (const city of config.cities) {
    const mem = memory.get(city.name);
    let dbAt = null;
    if (db.isReady()) {
      try {
        const r = await db.query('SELECT updated_at FROM weather_cache WHERE city_name = $1', [city.name]);
        if (r.rows.length) dbAt = new Date(r.rows[0].updated_at).toISOString();
      } catch { /* reported via db.status() */ }
    }
    rows.push({
      city_name: city.name,
      updated_at: mem ? mem.updatedAt.toISOString() : dbAt,
      memory_updated_at: mem ? mem.updatedAt.toISOString() : null,
      db_updated_at: dbAt,
      day_labels_current: mem ? hasCurrentDayLabels(mem.data) : null,
      fresh: mem ? isFresh(mem) : false,
    });
  }
  return rows;
}

module.exports = {
  getWeather, fetchAndCache, read, isFresh, cityByName, storeStats, statusRows, fetchFromApi,
};
