'use strict';
// ---------------------------------------------------------------------------
// Future tab (was "CZ future" / "HU future" — now one tab, CZ over HU).
//
// A 6-day outlook per country, using the capital as the country proxy:
// temperatures at 08/12/16/20/00 plus pressure, wind, weather, cloud cover and
// solar (FVE) potential, with auto-generated notes.
//
// v3.0 fix for "Graphs and Future sometimes show different values": the
// temperatures here now come from the SAME global-median model set the Graphs
// use, instead of best_match alone. Everything that is not on the Graphs
// (pressure, cloud, radiation, weather code) still comes from the single
// best_match call, because there is nothing to disagree with.
// ---------------------------------------------------------------------------

const { config } = require('../config');
const logger = require('../logger');
const { createCache } = require('../lib/cache');
const { fetchJson } = require('../lib/openmeteo');
const { medianHourlyMap } = require('../weather/median');
const { normaliseSource } = require('../weather');
const {
  describeWeather, weatherIcon, isStormCode,
  classifyPressure, classifyWind, classifyClouds,
} = require('./weather-codes');

const F = config.future;
const LABELS = F.LABELS;

// Build the per-day structure from a raw Open-Meteo response. Pure + testable.
// Any value not present in the response becomes null — never invented.
function parseFuture(raw) {
  if (!raw || !raw.daily || !Array.isArray(raw.daily.time)) return [];
  const h = raw.hourly || {};
  const hTime = Array.isArray(h.time) ? h.time : [];
  const idxByTime = {};
  for (let i = 0; i < hTime.length; i++) idxByTime[hTime[i]] = i;

  const numAt = (arr, t) => {
    const i = idxByTime[t];
    if (i === undefined || !Array.isArray(arr)) return null;
    const v = arr[i];
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  };
  const dailyNum = (arr, di) => {
    if (!Array.isArray(arr)) return null;
    const v = arr[di];
    return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
  };

  const days = [];
  const nDays = Math.min(raw.daily.time.length, 6);
  for (let di = 0; di < nDays; di++) {
    const date = raw.daily.time[di];

    let cloudSum = 0, cloudN = 0;
    if (Array.isArray(h.cloud_cover)) {
      for (let i = 0; i < hTime.length; i++) {
        if (typeof hTime[i] === 'string' && hTime[i].slice(0, 10) === date) {
          const v = h.cloud_cover[i];
          if (typeof v === 'number' && !Number.isNaN(v)) { cloudSum += v; cloudN++; }
        }
      }
    }
    const cloudMean = cloudN > 0 ? cloudSum / cloudN : null;

    let wCode = null;
    if (Array.isArray(raw.daily.weather_code) && typeof raw.daily.weather_code[di] === 'number') {
      wCode = raw.daily.weather_code[di];
    }
    const pressure = numAt(h.pressure_msl, `${date}T12:00`);
    const gustMax = dailyNum(raw.daily.wind_gusts_10m_max, di);

    days.push({
      label: LABELS[di] || `D+${di}`,
      date,
      temp: {
        h8: numAt(h.temperature_2m, `${date}T08:00`),
        h12: numAt(h.temperature_2m, `${date}T12:00`),
        h16: numAt(h.temperature_2m, `${date}T16:00`),
        h20: numAt(h.temperature_2m, `${date}T20:00`),
        h0: numAt(h.temperature_2m, `${date}T00:00`),
      },
      tempMax: dailyNum(raw.daily.temperature_2m_max, di),
      tempMin: dailyNum(raw.daily.temperature_2m_min, di),
      pressure: { value: pressure, class: classifyPressure(pressure) },
      wind: { gustMax, class: classifyWind(gustMax) },
      weather: { code: wCode, desc: describeWeather(wCode), icon: weatherIcon(wCode) },
      clouds: { meanPct: cloudMean === null ? null : Math.round(cloudMean), class: classifyClouds(cloudMean) },
      solar: { radSum: dailyNum(raw.daily.shortwave_radiation_sum, di) },
      precipSum: dailyNum(raw.daily.precipitation_sum, di),
      notes: [],
    });
  }
  return days;
}

// Overlay global-median temperatures onto the parsed days. Pure + testable:
// `map` is { 'YYYY-MM-DDTHH:00': °C }. Daily max/min are recomputed from the
// median series so they cannot contradict the hourly numbers above them.
function applyMedianTemps(days, map) {
  if (!map) return days;
  const at = key => (typeof map[key] === 'number' ? map[key] : null);
  for (const day of days) {
    const t = {
      h8: at(`${day.date}T08:00`), h12: at(`${day.date}T12:00`),
      h16: at(`${day.date}T16:00`), h20: at(`${day.date}T20:00`),
      h0: at(`${day.date}T00:00`),
    };
    // Only take the median values when the median actually covers this day;
    // beyond the model horizon we keep whatever best_match returned.
    if (Object.values(t).every(v => v === null)) continue;
    for (const k of Object.keys(t)) if (t[k] !== null) day.temp[k] = t[k];

    const dayVals = [];
    for (let hh = 0; hh < 24; hh++) {
      const v = at(`${day.date}T${String(hh).padStart(2, '0')}:00`);
      if (v !== null) dayVals.push(v);
    }
    if (dayVals.length >= 20) {
      day.tempMax = +Math.max(...dayVals).toFixed(1);
      day.tempMin = +Math.min(...dayVals).toFixed(1);
    }
  }
  return days;
}

// ~11 simple IF/THEN rules — no AI needed at runtime. Pure + testable.
function buildNotes(prev, day) {
  const notes = [];
  const r = Math.round;
  const num = v => (typeof v === 'number' && !Number.isNaN(v));

  if (prev) {
    if (num(day.tempMax) && num(prev.tempMax)) {
      const d = day.tempMax - prev.tempMax;
      if (d >= 6) notes.push(`Much warmer (+${r(d)}°C)`);
      else if (d <= -6) notes.push(`Sharp cooldown (${r(d)}°C)`);
    }
    if (num(day.clouds.meanPct) && num(prev.clouds.meanPct)) {
      const d = day.clouds.meanPct - prev.clouds.meanPct;
      if (d >= 35) notes.push('Clouding over — solar drops');
      else if (d <= -35) notes.push('Clearing up — solar boost');
    }
    if (num(day.pressure.value) && num(prev.pressure.value)) {
      if (day.pressure.value - prev.pressure.value <= -8) notes.push('Pressure dropping — unsettled');
    }
    if (num(day.solar.radSum) && num(prev.solar.radSum) && prev.solar.radSum > 0) {
      const rel = (day.solar.radSum - prev.solar.radSum) / prev.solar.radSum;
      if (rel >= 0.3) notes.push('Stronger solar day');
      else if (rel <= -0.3) notes.push('Weaker solar day');
    }
  }
  if (isStormCode(day.weather.code)) notes.push('Storm risk');
  if (num(day.precipSum) && day.precipSum >= 15) notes.push(`Heavy rain (${r(day.precipSum)} mm)`);
  if (num(day.wind.gustMax) && day.wind.gustMax >= 60) notes.push(`Strong winds (${r(day.wind.gustMax)} km/h)`);
  if (num(day.tempMax) && day.tempMax >= 30) notes.push(`Hot day (${r(day.tempMax)}°C)`);
  if (num(day.tempMin) && day.tempMin <= 0) notes.push(`Frost (${r(day.tempMin)}°C)`);
  return notes;
}

const cache = createCache({ name: 'future', ttlMs: F.CACHE_MS, maxEntries: 16, staleOnError: true });

async function fetchCountry(country, source) {
  const src = normaliseSource(source);
  const city = config.cities.find(c => c.name === country.capital);
  if (!city) throw new Error(`Unknown capital ${country.capital}`);

  return cache.get(`${country.code}|${src}`, async () => {
    const hourly = 'temperature_2m,cloud_cover,pressure_msl,wind_gusts_10m,shortwave_radiation,weather_code';
    const daily = 'weather_code,temperature_2m_max,temperature_2m_min,shortwave_radiation_sum,precipitation_sum,wind_gusts_10m_max,sunshine_duration';

    const raw = await fetchJson('forecast', {
      latitude: city.lat, longitude: city.lon, hourly, daily,
      forecast_days: 6, timezone: country.tz, wind_speed_unit: 'kmh',
    }, { label: `future ${country.code}` });

    const days = parseFuture(raw);

    // The median overlay is best-effort: if it fails the tab still renders,
    // it just falls back to best_match and says so.
    let models = null;
    if (src === 'median') {
      try {
        const { map, models: used } = await medianHourlyMap(city, { forecastDays: 6, tz: country.tz });
        applyMedianTemps(days, map);
        models = used;
      } catch (err) {
        logger.warn('median overlay failed for Future — using best_match', {
          country: country.code, err: err.message,
        });
      }
    }

    for (let i = 0; i < days.length; i++) days[i].notes = buildNotes(i > 0 ? days[i - 1] : null, days[i]);

    return {
      country: country.code,
      name: country.name,
      capital: country.capital,
      timezone: country.tz,
      source: models ? 'median' : 'openmeteo',
      requestedSource: src,
      models,
      generatedAt: new Date().toISOString(),
      units: { temp: '°C', pressure: 'hPa', wind: 'km/h gusts', clouds: '%', solar: 'MJ/m² (daily)' },
      days,
    };
  });
}

// Both countries at once — the tab shows CZ above HU, so one round trip.
async function fetchAll(source) {
  const results = await Promise.allSettled(F.COUNTRIES.map(c => fetchCountry(c, source)));
  const countries = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!countries.length) {
    const first = results.find(r => r.status === 'rejected');
    throw (first ? first.reason : new Error('No country data'));
  }
  return { generatedAt: new Date().toISOString(), countries };
}

module.exports = {
  parseFuture, buildNotes, applyMedianTemps, fetchCountry, fetchAll,
  clear: () => cache.clear(),
};
