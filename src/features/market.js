'use strict';
// ---------------------------------------------------------------------------
// Market brief (CZ / HU) — what the weather means for power fundamentals.
//
// v3.0 rewrite. The v2.0 brief was right in substance and unreadable in
// practice: every cell was a sentence, the risks were pre-formatted emoji
// strings, and the "what does this mean" text lived in a paragraph under the
// table. This version returns STRUCTURED, numeric output — typed risk objects,
// an explicit residual-load call with the drivers that produced it, and
// forecast stability folded in — so the UI can render chips, bars and one
// unambiguous verdict per day instead of prose.
//
// Fundamentals only. Not price advice.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const logger = require('../logger');
const { createCache } = require('../lib/cache');
const { fetchJson } = require('../lib/openmeteo');
const { round } = require('../lib/stats');
const { isStormCode, isSnowCode, isFogCode, weatherIcon, describeWeather } = require('./weather-codes');

const M = config.market;
const LABELS = M.LABELS;

// ---- pure index maths -------------------------------------------------------

// 0..1 output of a simplified turbine for one hub-height speed (km/h).
function windPowerAt(kmh, w = M.WIND) {
  if (typeof kmh !== 'number' || Number.isNaN(kmh)) return null;
  if (kmh < w.CUT_IN || kmh >= w.CUT_OUT) return 0;
  if (kmh >= w.RATED) return 1;
  const x = (kmh ** 3 - w.CUT_IN ** 3) / (w.RATED ** 3 - w.CUT_IN ** 3);
  return Math.min(1, Math.max(0, x));
}

// Mean 0..1 power index across a day's hourly hub-height speeds.
function windPowerIndex(speeds, w = M.WIND) {
  if (!Array.isArray(speeds)) return null;
  let sum = 0, n = 0;
  for (const s of speeds) {
    const p = windPowerAt(s, w);
    if (p !== null) { sum += p; n++; }
  }
  return n ? sum / n : null;
}

// 0..1 solar index: daily radiation total vs the clear-sky-ish monthly max.
function solarIndex(radSumMJ, monthIndex0, cfg = M) {
  if (typeof radSumMJ !== 'number' || Number.isNaN(radSumMJ)) return null;
  const max = cfg.SOLAR_MAX_BY_MONTH[monthIndex0] || 20;
  return Math.min(1, Math.max(0, radSumMJ / max));
}

// Heating / cooling degree days from daily max+min (simple mean method).
function degreeDays(tmax, tmin, cfg = M) {
  if (typeof tmax !== 'number' || typeof tmin !== 'number' ||
      Number.isNaN(tmax) || Number.isNaN(tmin)) {
    return { mean: null, hdd: null, cdd: null };
  }
  const mean = (tmax + tmin) / 2;
  return {
    mean: +mean.toFixed(1),
    hdd: Math.max(0, +(cfg.HDD_BASE - mean).toFixed(1)),
    cdd: Math.max(0, +(mean - cfg.CDD_BASE).toFixed(1)),
  };
}

function signalDir(delta, upAt, downAt) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return null;
  if (delta >= upAt) return 'up';
  if (delta <= downAt) return 'down';
  return 'flat';
}

// ---- residual load ----------------------------------------------------------
//
// Residual load = demand minus what sun and wind cover. Renewables push it DOWN,
// temperature-driven demand pushes it UP. v2.0 expressed this as one of five
// canned sentences; here it is a signed score with the drivers attached, so the
// UI can show the verdict AND why.
//
//   solarDelta / windDelta : percentage points of index, day over day
//   demandDelta            : degree days, day over day
function residualLoad(solarDelta, windDelta, demandDelta) {
  const has = v => v !== null && v !== undefined && !Number.isNaN(v);
  if (!has(solarDelta) && !has(windDelta) && !has(demandDelta)) {
    return { direction: 'unknown', score: null, drivers: [], summary: 'Not enough data.' };
  }
  const s = has(solarDelta) ? solarDelta : 0;
  const w = has(windDelta) ? windDelta : 0;
  const d = has(demandDelta) ? demandDelta : 0;

  // Weights chosen so a typical day's swing lands inside ±100: renewable index
  // moves ~±30 pp, degree days move ~±4.
  const raw = d * 8 - (s + w) * 0.8;
  const score = Math.max(-100, Math.min(100, +raw.toFixed(0)));

  const direction = score >= 10 ? 'tighter' : (score <= -10 ? 'softer' : 'neutral');
  const strength = Math.abs(score) >= 35 ? 'strong' : (Math.abs(score) >= 10 ? 'moderate' : 'slight');

  const drivers = [];
  if (has(solarDelta) && Math.abs(solarDelta) >= 5) {
    drivers.push({ key: 'solar', label: 'Solar', value: `${solarDelta > 0 ? '+' : ''}${solarDelta}pp`,
                   effect: solarDelta > 0 ? 'softer' : 'tighter' });
  }
  if (has(windDelta) && Math.abs(windDelta) >= 5) {
    drivers.push({ key: 'wind', label: 'Wind', value: `${windDelta > 0 ? '+' : ''}${windDelta}pp`,
                   effect: windDelta > 0 ? 'softer' : 'tighter' });
  }
  if (has(demandDelta) && Math.abs(demandDelta) >= 0.5) {
    drivers.push({ key: 'demand', label: 'Demand', value: `${demandDelta > 0 ? '+' : ''}${demandDelta} DD`,
                   effect: demandDelta > 0 ? 'tighter' : 'softer' });
  }

  const summary = direction === 'neutral'
    ? 'No material shift vs the previous day.'
    : `${strength[0].toUpperCase()}${strength.slice(1)}ly ${direction} residual load vs the previous day.`;

  return { direction, score, strength, drivers, summary };
}

// ---- per-city parsing -------------------------------------------------------

function parseMarketCity(raw, cfg = M) {
  if (!raw || !raw.daily || !Array.isArray(raw.daily.time)) return [];
  const h = raw.hourly || {};
  const hTime = Array.isArray(h.time) ? h.time : [];
  const num = v => (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  const dnum = (arr, i) => Array.isArray(arr) ? num(arr[i]) : null;

  const days = [];
  for (let di = 0; di < raw.daily.time.length; di++) {
    const date = raw.daily.time[di];
    const winds = [];
    let stormHours = 0, fogMorning = false, snow = false, cloudSum = 0, cloudN = 0;
    let gustCutoutHours = 0;
    for (let i = 0; i < hTime.length; i++) {
      if (typeof hTime[i] !== 'string' || hTime[i].slice(0, 10) !== date) continue;
      const hr = parseInt(hTime[i].slice(11, 13), 10);
      const w = num(Array.isArray(h.wind_speed_120m) ? h.wind_speed_120m[i] : null);
      if (w !== null) {
        winds.push(w);
        if (w >= cfg.WIND.CUT_OUT) gustCutoutHours++;
      }
      const code = num(Array.isArray(h.weather_code) ? h.weather_code[i] : null);
      if (code !== null) {
        if (isStormCode(code)) stormHours++;
        if (isFogCode(code) && hr >= 5 && hr <= 10) fogMorning = true;
        if (isSnowCode(code)) snow = true;
      }
      if (hr >= 9 && hr <= 17) {
        const c = num(Array.isArray(h.cloud_cover) ? h.cloud_cover[i] : null);
        if (c !== null) { cloudSum += c; cloudN++; }
      }
    }
    const tmax = dnum(raw.daily.temperature_2m_max, di);
    const tmin = dnum(raw.daily.temperature_2m_min, di);
    const radSum = dnum(raw.daily.shortwave_radiation_sum, di);
    const monthIdx = parseInt(String(date).slice(5, 7), 10) - 1;
    days.push({
      date, tmax, tmin,
      dd: degreeDays(tmax, tmin, cfg),
      radSum,
      solarIdx: solarIndex(radSum, monthIdx, cfg),
      windMean: winds.length ? winds.reduce((a, b) => a + b, 0) / winds.length : null,
      windIdx: windPowerIndex(winds, cfg.WIND),
      windPeak: winds.length ? Math.max(...winds) : null,
      gustMax: dnum(raw.daily.wind_gusts_10m_max, di),
      gustCutoutHours,
      precipSum: dnum(raw.daily.precipitation_sum, di),
      cloudDaytimePct: cloudN ? Math.round(cloudSum / cloudN) : null,
      weatherCode: dnum(raw.daily.weather_code, di),
      stormHours, stormy: stormHours > 0, fogMorning, snow,
    });
  }
  return days;
}

// ---- structured risks -------------------------------------------------------
// Typed objects, not pre-formatted strings: severity drives the colour, the
// short label goes on the chip, the detail goes in the hover.
function buildRisks(di, valid, wAvg, cfg) {
  const risks = [];
  const anyCity = getter => valid.filter(c => getter(c.days[di])).map(c => c.city);

  const stormCities = anyCity(d => d.stormy);
  if (stormCities.length) {
    const hours = Math.max(...valid.map(c => c.days[di].stormHours || 0));
    risks.push({ id: 'storm', icon: '⛈', severity: 'high', label: 'Storms',
      value: `${hours} h`,
      detail: `Thunderstorms forecast over ${stormCities.join(', ')} for about ${hours} hour(s). Lightning faults, trips and sudden supply/demand swings.` });
  }

  const gust = Math.max(...valid.map(c => (c.days[di].gustMax ?? -Infinity)));
  if (Number.isFinite(gust)) {
    if (gust >= cfg.WIND.CUT_OUT) {
      risks.push({ id: 'cutout', icon: '🌪', severity: 'high', label: 'Turbine cut-out',
        value: `${Math.round(gust)} km/h`,
        detail: `Peak gusts reach ${Math.round(gust)} km/h, at or above the ${cfg.WIND.CUT_OUT} km/h cut-out. Wind output can drop to zero exactly when it looks strongest.` });
    } else if (gust >= 70) {
      risks.push({ id: 'gusts', icon: '💨', severity: 'medium', label: 'Strong gusts',
        value: `${Math.round(gust)} km/h`,
        detail: `Peak gusts ${Math.round(gust)} km/h — below cut-out but enough to raise line-fault and trip risk.` });
    }
  }

  if (anyCity(d => d.fogMorning).length) {
    risks.push({ id: 'fog', icon: '🌫', severity: 'medium', label: 'Morning fog', value: '',
      detail: 'Fog between 05:00 and 10:00 delays the solar ramp — PV comes on late and the morning peak leans harder on thermal.' });
  }
  if (anyCity(d => d.snow).length) {
    risks.push({ id: 'snow', icon: '❄', severity: 'medium', label: 'Snow', value: '',
      detail: 'Snowfall soils and covers panels (PV losses) while raising heating load.' });
  }

  const tmax = round(wAvg(di, d => d.tmax));
  const tmin = round(wAvg(di, d => d.tmin));
  if (tmax !== null && tmax >= 30) {
    risks.push({ id: 'heat', icon: '🔥', severity: 'high', label: 'Heat', value: `${Math.round(tmax)}°`,
      detail: `Population-weighted max ${Math.round(tmax)}°C — AC load climbs and thermal plant, lines and panels all derate.` });
  }
  if (tmin !== null && tmin <= 0) {
    risks.push({ id: 'frost', icon: '🧊', severity: 'medium', label: 'Frost', value: `${Math.round(tmin)}°`,
      detail: `Population-weighted min ${Math.round(tmin)}°C — heating load rises through the morning peak.` });
  }
  const precip = round(wAvg(di, d => d.precipSum));
  if (precip !== null && precip >= 15) {
    risks.push({ id: 'rain', icon: '🌧', severity: 'low', label: 'Heavy rain', value: `${Math.round(precip)} mm`,
      detail: `${Math.round(precip)} mm across the day — cuts solar, feeds hydro inflow.` });
  }
  return risks;
}

// ---- country brief ----------------------------------------------------------

function buildMarketBrief(countryCode, perCity, cfg = M) {
  const country = cfg.COUNTRIES[countryCode];
  const valid = (perCity || []).filter(c => Array.isArray(c.days) && c.days.length);
  if (!country || !valid.length) return null;
  const nDays = Math.min(4, ...valid.map(c => c.days.length));

  const wAvg = (di, getter) => {
    let sum = 0, w = 0;
    for (const c of valid) {
      const v = getter(c.days[di]);
      if (typeof v === 'number' && !Number.isNaN(v)) { sum += v * c.weight; w += c.weight; }
    }
    return w > 0 ? sum / w : null;
  };
  const pct = v => (v === null ? null : Math.round(v * 100));

  const days = [];
  for (let di = 0; di < nDays; di++) {
    const gust = Math.max(...valid.map(c => (c.days[di].gustMax ?? -Infinity)));
    const code = valid[0].days[di].weatherCode;
    days.push({
      label: LABELS[di] || `D+${di - 1}`,
      date: valid[0].days[di].date,
      context: di === 0,                                    // yesterday = actual, not a signal
      tempMax: round(wAvg(di, d => d.tmax)),
      tempMin: round(wAvg(di, d => d.tmin)),
      tempMean: round(wAvg(di, d => d.dd.mean)),
      hdd: round(wAvg(di, d => d.dd.hdd)),
      cdd: round(wAvg(di, d => d.dd.cdd)),
      weather: { code, desc: describeWeather(code), icon: weatherIcon(code) },
      solar: {
        sumMJ: round(wAvg(di, d => d.radSum)),
        index: pct(wAvg(di, d => d.solarIdx)),
        cloudPct: (() => { const c = wAvg(di, d => d.cloudDaytimePct); return c === null ? null : Math.round(c); })(),
      },
      wind: {
        meanKmh: round(wAvg(di, d => d.windMean)),
        peakKmh: round(wAvg(di, d => d.windPeak)),
        index: pct(wAvg(di, d => d.windIdx)),
        gustMax: Number.isFinite(gust) ? Math.round(gust) : null,
        cutoutHours: Math.max(...valid.map(c => c.days[di].gustCutoutHours || 0)),
      },
      precipMm: round(wAvg(di, d => d.precipSum)),
      risks: buildRisks(di, valid, wAvg, cfg),
      deltas: {}, signals: {}, residual: null,
    });
  }

  // Day-over-day deltas, signals and the residual-load call (skip the context day).
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1], day = days[i];
    const dp = (a, b) => (a !== null && a !== undefined && b !== null && b !== undefined) ? +(a - b).toFixed(1) : null;

    const solarDelta = dp(day.solar.index, prev.solar.index);
    const windDelta = dp(day.wind.index, prev.wind.index);
    const tempDelta = dp(day.tempMax, prev.tempMax);
    const ddNow = (day.hdd ?? 0) + (day.cdd ?? 0);
    const ddPrev = (prev.hdd ?? 0) + (prev.cdd ?? 0);
    const demandDelta = (day.hdd === null && day.cdd === null) ? null : +(ddNow - ddPrev).toFixed(1);

    day.deltas = { solar: solarDelta, wind: windDelta, demand: demandDelta, tempMax: tempDelta };
    day.signals = {
      solar: signalDir(solarDelta, 10, -10),
      wind: signalDir(windDelta, 10, -10),
      demand: signalDir(demandDelta, 1.5, -1.5),
    };
    day.demandKind = (day.cdd ?? 0) > (day.hdd ?? 0) ? 'cooling' : 'heating';
    day.residual = residualLoad(solarDelta, windDelta, demandDelta);
  }

  // One headline per country: the single most important thing today/tomorrow.
  const tomorrow = days.find(d => d.label === 'Tomorrow') || days[days.length - 1];
  const topRisk = (tomorrow.risks || []).slice().sort(
    (a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]))[0] || null;

  return {
    country: countryCode,
    name: country.name,
    timezone: country.tz,
    cities: valid.map(c => ({ name: c.city, weight: c.weight })),
    headline: {
      day: tomorrow.label,
      residual: tomorrow.residual,
      topRisk,
      solarIndex: tomorrow.solar.index,
      windIndex: tomorrow.wind.index,
      tempMax: tomorrow.tempMax,
    },
    days,
  };
}

// ---- fetching ---------------------------------------------------------------

async function fetchMarketCity(city, tz) {
  const raw = await fetchJson('forecast', {
    latitude: city.lat, longitude: city.lon,
    hourly: 'temperature_2m,cloud_cover,shortwave_radiation,wind_speed_120m,precipitation,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration,weather_code',
    past_days: 1, forecast_days: 3, timezone: tz, wind_speed_unit: 'kmh',
  }, { label: `market ${city.name}` });
  return parseMarketCity(raw);
}

const cache = createCache({ name: 'market', ttlMs: M.CACHE_MS, maxEntries: 8, staleOnError: true });

async function marketBrief(countryCode) {
  return cache.get(countryCode, async () => {
    const country = M.COUNTRIES[countryCode];
    if (!country) throw new Error(`Unknown country ${countryCode}`);

    // Any single city failing just drops out of the weighted average.
    const perCity = await Promise.all(country.cities.map(cc => {
      const city = config.cities.find(c => c.name === cc.name);
      if (!city) return { city: cc.name, weight: cc.weight, days: [] };
      return fetchMarketCity(city, country.tz)
        .then(days => ({ city: cc.name, weight: cc.weight, days }))
        .catch(err => {
          logger.warn('market city fetch failed', { city: cc.name, err: err.message });
          return { city: cc.name, weight: cc.weight, days: [] };
        });
    }));

    const brief = buildMarketBrief(countryCode, perCity, M);
    if (!brief) throw new Error('No market data from any city');
    return { generatedAt: new Date().toISOString(), ...brief };
  });
}

module.exports = {
  parseMarketCity, buildMarketBrief, windPowerAt, windPowerIndex, solarIndex,
  degreeDays, signalDir, residualLoad, buildRisks, marketBrief,
  clear: () => cache.clear(),
};
