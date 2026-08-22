'use strict';
// Pure transforms between raw Open-Meteo payloads and the app's per-day series
// structure. No network, no cache, no clock beyond getDateString — all of this
// is unit tested.

const { getDateString } = require('../lib/dates');
const { config } = require('../config');

// Days that hold already-happened weather, oldest first.
const PAST_KEYS = ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo', 'fourDaysAgo',
                   'threeDaysAgo', 'twoDaysAgo', 'yesterday'];
// Days that are frozen once written (2+ days old — see freezePastDays).
const FROZEN_KEYS = PAST_KEYS.slice(0, 6);
// Every key that carries a dated 24-hour series.
const DAY_KEYS = [...PAST_KEYS, 'today', 'tomorrow', 'dayAfterTomorrow'];
// The 3-7-days-ago average shown as the faint reference line.
const AVG_SOURCE_KEYS = ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo', 'fourDaysAgo', 'threeDaysAgo'];

const OFFSETS = {
  sevenDaysAgo: -7, sixDaysAgo: -6, fiveDaysAgo: -5, fourDaysAgo: -4,
  threeDaysAgo: -3, twoDaysAgo: -2, yesterday: -1, today: 0,
  tomorrow: 1, dayAfterTomorrow: 2,
};

// Recompute the 3-7-days-ago average in place.
function computePastAvg(result) {
  const avg = { date: 'avg', temps: Array(24).fill(null) };
  for (let hour = 0; hour < 24; hour++) {
    let sum = 0, count = 0;
    for (const day of AVG_SOURCE_KEYS) {
      const t = result[day] && result[day].temps[hour];
      if (typeof t === 'number' && !Number.isNaN(t)) { sum += t; count++; }
    }
    avg.temps[hour] = count > 0 ? sum / count : null;
  }
  result.pastDaysAvg = avg;
  return result;
}

// Overlay previously-cached values onto a fresh fetch for days that are 2+ days
// old, matched by DATE (the day KEYS shift every midnight, the dates do not).
// Cached nulls are gap-filled from fresh data; yesterday/today keep updating,
// because re-analysis there is genuinely useful. Returns how many fresh values
// were overridden by frozen history.
function freezePastDays(fresh, cached, enabled = config.weather.freezePast) {
  if (!enabled || !fresh || !cached) return 0;
  const cachedByDate = {};
  for (const k of DAY_KEYS) {
    const d = cached[k];
    if (d && d.date && Array.isArray(d.temps)) cachedByDate[d.date] = d.temps;
  }
  let overridden = 0;
  for (const k of FROZEN_KEYS) {
    const day = fresh[k];
    if (!day || !day.date || !cachedByDate[day.date]) continue;
    const prev = cachedByDate[day.date];
    for (let h = 0; h < 24; h++) {
      if (prev[h] === null || prev[h] === undefined) continue; // gap-fill from fresh
      if (day.temps[h] !== prev[h]) overridden++;
      day.temps[h] = prev[h];
    }
  }
  if (overridden > 0) computePastAvg(fresh);
  fresh.frozenPast = { enabled: true, overriddenValues: overridden };
  return overridden;
}

// Build the app's per-day structure from raw payloads.
//   data     : forecast response
//   prevData : previous-runs response, or null
function parseWeatherPayload(data, prevData) {
  const days = {};
  for (const [key, off] of Object.entries(OFFSETS)) days[key] = getDateString(off);

  const result = { updatedAt: new Date().toISOString() };
  for (const key of DAY_KEYS) result[key] = { date: days[key], temps: Array(24).fill(null) };
  // What YESTERDAY's model run said about today and tomorrow. The gap between
  // these and the live lines is the forecast revision — a tradeable signal.
  result.todayForecast = { date: days.today, temps: Array(24).fill(null) };
  result.tomorrowForecast = { date: days.tomorrow, temps: Array(24).fill(null) };

  const byDate = {};
  for (const key of DAY_KEYS) byDate[days[key]] = result[key];

  const times = (data && data.hourly && data.hourly.time) || [];
  const temps = (data && data.hourly && data.hourly.temperature_2m) || [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (typeof t !== 'string') continue;
    const slot = byDate[t.slice(0, 10)];
    if (!slot) continue;
    const hour = parseInt(t.slice(11, 13), 10);
    if (hour >= 0 && hour <= 23) slot.temps[hour] = temps[i];
  }

  const prevHourly = prevData && prevData.hourly;
  if (prevHourly && Array.isArray(prevHourly.temperature_2m_previous_day1)) {
    const pTimes = prevHourly.time || [];
    const pTemps = prevHourly.temperature_2m_previous_day1;
    for (let i = 0; i < pTimes.length; i++) {
      const t = pTimes[i];
      if (typeof t !== 'string') continue;
      const date = t.slice(0, 10);
      const hour = parseInt(t.slice(11, 13), 10);
      if (hour < 0 || hour > 23) continue;
      if (date === days.today) result.todayForecast.temps[hour] = pTemps[i];
      else if (date === days.tomorrow) result.tomorrowForecast.temps[hour] = pTemps[i];
    }
  }

  return computePastAvg(result);
}

// Is this payload still labelled for the CURRENT day?
//
// This is the fix for one of the nastiest bugs in the audit: the day labels are
// resolved once, at fetch time, and the only freshness rule was a flat 1-hour
// TTL. A payload written at 23:40 was therefore served as authoritative until
// 00:40 — with "Today" meaning yesterday. Worse, the cross-check compared that
// stale array against freshly fetched data for the real today and could mark
// perfectly good hours as "suspect" or overwrite them.
function hasCurrentDayLabels(data) {
  return !!(data && data.today && data.today.date === getDateString(0));
}

module.exports = {
  parseWeatherPayload, computePastAvg, freezePastDays, hasCurrentDayLabels,
  DAY_KEYS, FROZEN_KEYS, PAST_KEYS, AVG_SOURCE_KEYS, OFFSETS,
};
