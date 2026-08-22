'use strict';
// ---------------------------------------------------------------------------
// Weekly tab (was "History").
//
// Hour-by-hour temperatures for one city and one ISO week (Mon–Sun): 24 rows ×
// 7 day columns. Finished weeks come from Open-Meteo's Historical Forecast
// archive; recent weeks use the forecast endpoint's past_days. Hours that have
// not happened yet are filled from the models' forecasts (~16-day horizon) and
// the response's `cutoff` marks the past/future boundary.
//
// v3.0 fix: weeks are addressed by (year, week), not by week number alone.
// v2.0 derived the year from "now", so in January the tab could offer three
// weeks total and the previous year was simply unreachable — a functional hole
// in a post-trade review tool.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const { createCache } = require('../lib/cache');
const { fetchJson, extractModelSeries } = require('../lib/openmeteo');
const { medianOf } = require('../lib/stats');
const {
  isoWeekOf, isoWeekDates, isoWeeksInYear, shiftIsoWeek, nowInTz, daysBetween,
} = require('../lib/dates');

const W = config.weekly;
const SOURCES = config.models;                 // one shared model list, no duplicate
const TZ_BY_CITY = { Prague: 'Europe/Prague', Budapest: 'Europe/Budapest' };

function tzForCity(name) { return TZ_BY_CITY[name] || config.app.timezone; }

// Pure: assemble the 24×7 matrix from per-source hourly maps.
//   perSource : [{ id, label, values: { 'YYYY-MM-DDTHH:00': number } }]
//   days      : the week's 7 'YYYY-MM-DD' dates (Mon..Sun)
//   mode      : 'openmeteo' (best_match only) | 'median' (all sources)
function buildWeeklyTable(perSource, days, mode) {
  const list = (perSource || []).filter(s => s && s.values);
  const used = mode === 'median' ? list : list.filter(s => s.id === 'best_match');

  const counts = {};
  const temps = [];
  for (let h = 0; h < 24; h++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const key = `${days[d]}T${String(h).padStart(2, '0')}:00`;
      const vals = [];
      for (const s of used) {
        const v = s.values[key];
        if (typeof v === 'number' && !Number.isNaN(v)) {
          vals.push(v);
          counts[s.id] = (counts[s.id] || 0) + 1;
        }
      }
      row.push(mode === 'median' ? medianOf(vals) : (vals.length ? vals[0] : null));
    }
    temps.push(row);
  }
  const sources = used.filter(s => counts[s.id] > 0)
    .map(s => ({ id: s.id, label: s.label, hours: counts[s.id] }));
  return { temps, sources };
}

// All requested models in ONE call. With several models the response suffixes
// each variable; with one it stays plain. A model the location does not support
// simply has no array — skipped, never fatal.
async function fetchWeeklyBatch(city, ids, days, tz, recentDays, forecastDays) {
  const params = {
    latitude: city.lat, longitude: city.lon,
    hourly: 'temperature_2m', models: ids, timezone: tz,
  };
  const host = recentDays === null ? 'historicalForecast' : 'forecast';
  if (recentDays === null) { params.start_date = days[0]; params.end_date = days[6]; }
  else { params.past_days = recentDays; params.forecast_days = forecastDays; }

  const raw = await fetchJson(host, params, { label: `weekly ${city.name}` });
  const out = [];
  for (const s of extractModelSeries(raw, 'temperature_2m', ids)) {
    const values = {};
    for (let i = 0; i < s.time.length; i++) {
      const v = s.values[i];
      if (typeof v === 'number' && !Number.isNaN(v)) values[s.time[i]] = v;
    }
    const meta = SOURCES.find(x => x.id === s.model);
    out.push({ id: s.model, label: meta ? meta.label : s.model, values });
  }
  return out;
}

const cache = createCache({
  name: 'weekly', ttlMs: W.CACHE_MS_CURRENT, maxEntries: 120, staleOnError: true,
});

// The selectable range, oldest → newest, as {year, week, start, end, tag}.
function weekOptions(tz = config.app.timezone) {
  const now = nowInTz(tz);
  const cur = isoWeekOf(now.date);
  const out = [];
  for (let n = -W.PAST_WEEKS; n <= W.FUTURE_WEEKS; n++) {
    const { year, week } = shiftIsoWeek(cur, n);
    const days = isoWeekDates(year, week);
    out.push({
      year, week, start: days[0], end: days[6],
      tag: n === 0 ? 'current' : (n > 0 ? 'upcoming' : 'past'),
    });
  }
  return { current: cur, today: now.date, weeks: out };
}

async function fetchWeekly(city, year, week, source) {
  const tz = tzForCity(city.name);
  const now = nowInTz(tz);
  const days = isoWeekDates(year, week);

  const ttl = days[6] < now.date ? W.CACHE_MS_PAST : W.CACHE_MS_CURRENT;
  const key = `${city.name}|${year}-W${week}|${source}`;

  return cache.get(key, async () => {
    // Finished long enough ago -> stable archive; otherwise the forecast
    // endpoint, with past_days for the elapsed part and forecast_days through
    // the end of the week (Open-Meteo caps forecasts at 16 days, so the far end
    // of week current+2 may stay blank).
    const useArchive = daysBetween(days[6], now.date) > W.ARCHIVE_LAG_DAYS;
    const recentDays = useArchive ? null : Math.min(92, Math.max(0, daysBetween(days[0], now.date)));
    const forecastDays = useArchive ? 1 : Math.min(16, Math.max(1, daysBetween(now.date, days[6]) + 1));

    const ids = (source === 'median' ? SOURCES : SOURCES.filter(s => s.id === 'best_match')).map(s => s.id);
    const perSource = await fetchWeeklyBatch(city, ids, days, tz, recentDays, forecastDays);
    if (!perSource.length) throw new Error('No weekly source responded');

    const { temps, sources } = buildWeeklyTable(perSource, days, source);
    return {
      city: city.name,
      year, week, start: days[0], end: days[6], days,
      source, sources,
      cutoff: now,                                   // past/future boundary
      endpoint: useArchive ? 'historical-forecast archive' : 'forecast past_days',
      units: { temp: '°C' },
      generatedAt: new Date().toISOString(),
      temps,
    };
  }, { ttlMs: ttl });
}

module.exports = {
  buildWeeklyTable, fetchWeekly, weekOptions, tzForCity, isoWeeksInYear,
  clear: () => cache.clear(),
};
