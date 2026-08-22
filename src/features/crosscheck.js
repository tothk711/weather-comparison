'use strict';
// ---------------------------------------------------------------------------
// Cross-check / confidence.
//
// A single model can produce an unrealistic value for an hour. The shown values
// for today and tomorrow are compared against independent sources (other
// Open-Meteo models in ONE batched call, plus MET Norway — a different agency
// entirely). If the shown value disagrees with the consensus by more than the
// threshold it is flagged; when the other sources agree TIGHTLY among
// themselves it is replaced by their median. The raw value is always preserved.
//
// analyzeCrossCheck is the highest-risk function in the codebase — it is the
// one thing that can silently change a displayed temperature. In v2.0 it had
// zero tests. It now has a suite of its own.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const logger = require('../logger');
const { createCache } = require('../lib/cache');
const { fetchJson, extractModelSeries, modelLabel } = require('../lib/openmeteo');
const { getDateString, localHourIndex } = require('../lib/dates');
const { getSeries } = require('../weather');
const { hasCurrentDayLabels } = require('../weather/parse');

const CC = config.crosscheck;
const TZ = config.app.timezone;

// Pure: compare shown values against other sources, hour by hour.
//   primary : number[24]            the values the app displays
//   sources : { label: number[24] } other models / providers
//
// Per-hour outcomes:
//   agree                          -> display = primary
//   primary off, others TIGHT      -> display = median of others (corrected)
//   primary off, others LOOSE      -> flag only (suspect), display = primary
//   primary missing, others TIGHT  -> display = median (filled)
function analyzeCrossCheck(primary, sources, cfg = CC) {
  const labels = Object.keys(sources || {});
  const prim = Array.isArray(primary) ? primary : [];
  const hours = [], suspectHours = [], correctedHours = [], filledHours = [];

  for (let h = 0; h < 24; h++) {
    const others = [];
    for (const lbl of labels) {
      const v = sources[lbl] && sources[lbl][h];
      if (typeof v === 'number' && !Number.isNaN(v)) others.push({ label: lbl, temp: v });
    }
    const p = (typeof prim[h] === 'number' && !Number.isNaN(prim[h])) ? prim[h] : null;
    let median = null, min = null, max = null, spread = null, deviation = null;
    let suspect = false, corrected = false, filled = false, display = p;

    if (others.length) {
      const vals = others.map(o => o.temp).sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      min = vals[0]; max = vals[vals.length - 1]; spread = max - min;
      const tight = others.length >= cfg.CONSENSUS_MIN_SOURCES && spread <= cfg.CONSENSUS_SPREAD_C;
      if (p !== null && others.length >= cfg.MIN_SOURCES) {
        deviation = Math.abs(p - median);
        if (deviation > cfg.DEVIATION_C) {
          if (tight) { corrected = true; display = median; }
          else { suspect = true; }
        }
      } else if (p === null && tight) {
        filled = true; display = median;
      }
    }
    if (suspect) suspectHours.push(h);
    if (corrected) correctedHours.push(h);
    if (filled) filledHours.push(h);
    hours.push({ hour: h, primary: p, display, others, median, min, max, spread, deviation,
                 suspect, corrected, filled });
  }

  // How tightly the independent sources agree among themselves. Small mean
  // spread = the models see the same weather = higher-confidence forecast.
  let spreadSum = 0, spreadN = 0, maxSpread = null, maxSpreadHour = null;
  for (const row of hours) {
    if (row.others.length >= 2 && row.spread !== null) {
      spreadSum += row.spread; spreadN++;
      if (maxSpread === null || row.spread > maxSpread) { maxSpread = row.spread; maxSpreadHour = row.hour; }
    }
  }
  return {
    hours, suspectHours, correctedHours, filledHours,
    meanSpread: spreadN ? +(spreadSum / spreadN).toFixed(2) : null,
    maxSpread: maxSpread === null ? null : +maxSpread.toFixed(2),
    maxSpreadHour, sourceCount: labels.length, sources: labels,
  };
}

// Turn one {time, values} series into 24-slot arrays for today + tomorrow.
function seriesToDays(time, values) {
  const dates = { [getDateString(0)]: 'today', [getDateString(1)]: 'tomorrow' };
  const out = { today: Array(24).fill(null), tomorrow: Array(24).fill(null) };
  const any = { today: false, tomorrow: false };
  for (let i = 0; i < time.length; i++) {
    const t = time[i];
    if (typeof t !== 'string') continue;
    const which = dates[t.slice(0, 10)];
    if (!which) continue;
    const hh = parseInt(t.slice(11, 13), 10);
    const v = values[i];
    if (typeof v === 'number' && !Number.isNaN(v) && hh >= 0 && hh <= 23) {
      out[which][hh] = v;
      any[which] = true;
    }
  }
  return { today: any.today ? out.today : null, tomorrow: any.tomorrow ? out.tomorrow : null };
}

async function fetchAllModelTemps(city) {
  try {
    const j = await fetchJson('forecast', {
      latitude: city.lat, longitude: city.lon, hourly: 'temperature_2m',
      models: CC.MODELS, forecast_days: 2, timezone: TZ,
    }, { label: `crosscheck models ${city.name}` });
    const out = {};
    for (const s of extractModelSeries(j, 'temperature_2m', CC.MODELS)) {
      const days = seriesToDays(s.time, s.values);
      if (days.today || days.tomorrow) out[modelLabel(s.model)] = days;
    }
    return out;
  } catch (e) {
    logger.warn('model cross-check fetch failed', { city: city.name, err: e.message });
    return {};
  }
}

async function fetchMetno(city) {
  // met.no's terms require a real contact address; without one, do not call it
  // at all rather than getting the app's IP banned.
  if (!config.upstream.metnoUserAgent) return null;
  try {
    const j = await fetchJson('metno', { lat: city.lat, lon: city.lon }, {
      label: `metno ${city.name}`,
      headers: { 'User-Agent': config.upstream.metnoUserAgent, Accept: 'application/json' },
      retries: 1,
    });
    const series = j && j.properties && j.properties.timeseries;
    if (!Array.isArray(series)) return null;
    const today = getDateString(0), tomorrow = getDateString(1);
    const out = { today: Array(24).fill(null), tomorrow: Array(24).fill(null) };
    const any = { today: false, tomorrow: false };
    for (const pt of series) {
      const temp = pt && pt.data && pt.data.instant && pt.data.instant.details
        ? pt.data.instant.details.air_temperature : null;
      if (typeof temp !== 'number' || Number.isNaN(temp)) continue;
      let hh = localHourIndex(pt.time, TZ, today);
      if (hh !== null) { out.today[hh] = temp; any.today = true; continue; }
      hh = localHourIndex(pt.time, TZ, tomorrow);
      if (hh !== null) { out.tomorrow[hh] = temp; any.tomorrow = true; }
    }
    if (!any.today && !any.tomorrow) return null;
    return { today: any.today ? out.today : null, tomorrow: any.tomorrow ? out.tomorrow : null };
  } catch (e) {
    logger.warn('MET Norway cross-check failed', { city: city.name, err: e.message });
    return null;
  }
}

// A cross-check verdict is only meaningful for the day it was computed on, so
// the cache entry expires at midnight as well as on age. v2.0 held verdicts for
// an hour with no such guard and could carry a bad one across the day boundary.
const cache = createCache({
  name: 'crosscheck',
  ttlMs: CC.CACHE_MS,
  maxEntries: 32,
  staleOnError: false,
  validate: result => result && result.forDate === getDateString(0),
});

async function crossCheckCity(city, source) {
  return cache.get(`${city.name}|${source || 'median'}`, async () => {
    const weather = await getSeries(city, source);
    if (!hasCurrentDayLabels(weather.data)) throw new Error('weather payload is not labelled for today');

    const dayTemps = which => (weather.data[which] && Array.isArray(weather.data[which].temps))
      ? weather.data[which].temps : Array(24).fill(null);

    const [modelDays, metno] = await Promise.all([fetchAllModelTemps(city), fetchMetno(city)]);

    const sources = {}, sourcesTomorrow = {};
    const addSource = (label, days) => {
      if (!days) return;
      if (days.today && !sources[label]) sources[label] = days.today;
      if (days.tomorrow && !sourcesTomorrow[label]) sourcesTomorrow[label] = days.tomorrow;
    };
    for (const [label, days] of Object.entries(modelDays)) addSource(label, days);
    addSource('MET Norway', metno);

    const analysis = analyzeCrossCheck(dayTemps('today'), sources, CC);
    const tomorrow = analyzeCrossCheck(dayTemps('tomorrow'), sourcesTomorrow, CC);
    const statusOf = a => a.sourceCount === 0 ? 'unavailable'
      : a.correctedHours.length ? 'corrected'
      : (a.suspectHours.length ? 'warning' : 'ok');

    return {
      city: city.name,
      source: weather.source,
      forDate: getDateString(0),
      generatedAt: new Date().toISOString(),
      timezone: TZ,
      deviationLimit: CC.DEVIATION_C,
      consensusSpreadLimit: CC.CONSENSUS_SPREAD_C,
      consensusMinSources: CC.CONSENSUS_MIN_SOURCES,
      ...analysis,                                  // today at top level
      tomorrow: { ...tomorrow, status: statusOf(tomorrow) },
      status: statusOf(analysis),
    };
  });
}

module.exports = { analyzeCrossCheck, seriesToDays, crossCheckCity, clear: () => cache.clear() };
