'use strict';
// ---------------------------------------------------------------------------
// Global median weather — the app's DEFAULT source.
//
// Every hour is the median across the implemented models, fetched with ONE
// batched `models=a,b,c` call per endpoint (v1.4.0 did twelve separate calls
// here and got the whole app rate-limited off Open-Meteo).
//
// v3.0 change: this module is also what the Future tab reads, so Graphs,
// Values, Future and Weekly can no longer disagree about what "the forecast"
// is — they are all the same numbers from the same models.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const { createCache } = require('../lib/cache');
const { fetchJson, extractModelSeries } = require('../lib/openmeteo');
const { medianSeries } = require('../lib/stats');
const { parseWeatherPayload, freezePastDays, hasCurrentDayLabels } = require('./parse');

const TZ = config.app.timezone;
const MODEL_IDS = config.modelIds;

// Median payloads are memory-only: Postgres stays reserved for the canonical
// best_match rows. `validate` is what stops a payload from being served after
// midnight with yesterday's day labels baked in.
const cache = createCache({
  name: 'median-weather',
  ttlMs: config.weather.cacheMs,
  maxEntries: 64,
  staleOnError: true,
  validate: entry => hasCurrentDayLabels(entry && entry.data),
});

async function fetchMedian(city) {
  const [raw, praw] = await Promise.all([
    fetchJson('forecast', {
      latitude: city.lat, longitude: city.lon, hourly: 'temperature_2m',
      past_days: 8, forecast_days: 3, timezone: TZ, models: MODEL_IDS,
    }, { label: `median forecast ${city.name}` }),
    fetchJson('previousRuns', {
      latitude: city.lat, longitude: city.lon,
      hourly: 'temperature_2m_previous_day1', forecast_days: 3,
      timezone: TZ, models: MODEL_IDS,
    }, { label: `median previous-runs ${city.name}` }).catch(() => null),
  ]);

  const mains = extractModelSeries(raw, 'temperature_2m', MODEL_IDS);
  if (!mains.length) throw new Error('no model series in response');
  const main = medianSeries(mains);

  let prevData = null;
  if (praw) {
    const prevs = extractModelSeries(praw, 'temperature_2m_previous_day1', MODEL_IDS);
    if (prevs.length) {
      const pm = medianSeries(prevs);
      prevData = { hourly: { time: pm.time, temperature_2m_previous_day1: pm.values } };
    }
  }

  const result = parseWeatherPayload({ hourly: { time: main.time, temperature_2m: main.values } }, prevData);
  result.sources = mains.map(s => s.model);
  return result;
}

async function getMedianWeather(city) {
  return cache.get(city.name, async () => {
    const previous = cache.peek(city.name);
    const data = await fetchMedian(city);
    // Median history is frozen exactly like best_match history.
    freezePastDays(data, previous && previous.value && previous.value.data);
    return { data, updatedAt: new Date() };
  });
}

// ---------------------------------------------------------------------------
// Median hourly temperatures over an arbitrary window, keyed 'YYYY-MM-DDTHH:00'.
// Used by the Future tab so its 6-day table shows the same numbers the Graphs
// show, instead of best_match alone.
// ---------------------------------------------------------------------------
async function medianHourlyMap(city, { pastDays = 0, forecastDays = 6, tz = TZ } = {}) {
  const raw = await fetchJson('forecast', {
    latitude: city.lat, longitude: city.lon, hourly: 'temperature_2m',
    past_days: pastDays, forecast_days: forecastDays, timezone: tz, models: MODEL_IDS,
  }, { label: `median hourly ${city.name}` });
  const series = extractModelSeries(raw, 'temperature_2m', MODEL_IDS);
  if (!series.length) throw new Error('no model series in response');
  const merged = medianSeries(series);
  const map = {};
  for (let i = 0; i < merged.time.length; i++) {
    if (typeof merged.values[i] === 'number') map[merged.time[i]] = merged.values[i];
  }
  return { map, models: series.map(s => s.model) };
}

function medianStats() { return cache.snapshot(); }
function clearMedian() { cache.clear(); }

module.exports = { getMedianWeather, medianHourlyMap, fetchMedian, medianStats, clearMedian };
