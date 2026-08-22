'use strict';
// Verify, Live and Future: the remaining pure builders the audit listed as
// untested.

const test = require('node:test');
const assert = require('node:assert');
const { runDataChecks } = require('../src/features/verify');
const { parseLive, liveDir } = require('../src/features/live');
const { parseFuture, buildNotes, applyMedianTemps } = require('../src/features/future');
const { describeWeather, weatherIcon, classifyPressure, classifyWind, classifyClouds } = require('../src/features/weather-codes');
const { haversineKm } = require('../src/lib/stats');
const { getDateString } = require('../src/lib/dates');

const CITY = { name: 'Prague', lat: 50.08, lon: 14.42 };

function goodData() {
  const d = {};
  for (const [k, off] of Object.entries({
    sevenDaysAgo: -7, sixDaysAgo: -6, fiveDaysAgo: -5, fourDaysAgo: -4,
    threeDaysAgo: -3, twoDaysAgo: -2, yesterday: -1, today: 0, tomorrow: 1, dayAfterTomorrow: 2,
  })) {
    d[k] = { date: getDateString(off), temps: Array.from({ length: 24 }, (_, h) => 15 + Math.sin(h / 4) * 5) };
  }
  return d;
}
const checkNamed = (r, name) => r.checks.find(c => c.name === name);

test('runDataChecks passes on clean data', () => {
  const r = runDataChecks(CITY, goodData(), null, null);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.checks.length, 5);
  assert.strictEqual(checkNamed(r, 'Temperatures in plausible range').pass, true);
});

test('runDataChecks catches an impossible temperature', () => {
  const d = goodData();
  d.today.temps[4] = 120;
  const r = runDataChecks(CITY, d, null, null);
  assert.strictEqual(r.status, 'warning');
  assert.strictEqual(checkNamed(r, 'Temperatures in plausible range').pass, false);
});

test('runDataChecks catches an impossible hourly jump', () => {
  const d = goodData();
  d.today.temps[10] = 5;
  d.today.temps[11] = 40;
  const r = runDataChecks(CITY, d, null, null);
  assert.strictEqual(checkNamed(r, 'No impossible hourly jumps').pass, false);
  assert.match(checkNamed(r, 'No impossible hourly jumps').detail, /11:00/);
});

test('runDataChecks catches too many missing recent hours', () => {
  const d = goodData();
  for (let h = 0; h < 8; h++) d.today.temps[h] = null;
  const r = runDataChecks(CITY, d, null, null);
  assert.strictEqual(checkNamed(r, 'Recent days complete').pass, false);
});

test('runDataChecks flags coordinates that do not match the city', () => {
  const far = runDataChecks(CITY, goodData(), { lat: 48.85, lon: 2.35, name: 'Paris' }, null);
  assert.strictEqual(checkNamed(far, 'Coordinates match city').pass, false);
  const near = runDataChecks(CITY, goodData(), { lat: 50.09, lon: 14.40, name: 'Prague' }, null);
  assert.strictEqual(checkNamed(near, 'Coordinates match city').pass, true);
  // No geocoder is a SKIP, not a failure.
  const none = runDataChecks(CITY, goodData(), null, null);
  assert.strictEqual(checkNamed(none, 'Coordinates match city').skipped, true);
});

test('runDataChecks compares against ERA5 when it is available', () => {
  const d = goodData();
  const era5 = {};
  for (const k of ['sevenDaysAgo', 'sixDaysAgo', 'fiveDaysAgo']) {
    for (let h = 0; h < 24; h++) era5[`${d[k].date}T${String(h).padStart(2, '0')}`] = d[k].temps[h] + 0.4;
  }
  const close = runDataChecks(CITY, d, null, era5);
  assert.strictEqual(checkNamed(close, 'Matches ERA5 reference archive').pass, true);

  const off = {};
  for (const key of Object.keys(era5)) off[key] = era5[key] + 9;
  const bad = runDataChecks(CITY, d, null, off);
  assert.strictEqual(checkNamed(bad, 'Matches ERA5 reference archive').pass, false);
  assert.strictEqual(bad.status, 'warning');
});

test('haversineKm measures real distances', () => {
  assert.ok(Math.abs(haversineKm(50.08, 14.42, 49.19, 16.61) - 185) < 12, 'Prague-Brno is about 185 km');
  assert.strictEqual(haversineKm(50, 14, 50, 14), 0);
});

test('liveDir applies its dead-band', () => {
  assert.strictEqual(liveDir(0.5, 0.1), 'up');
  assert.strictEqual(liveDir(-0.5, 0.1), 'down');
  assert.strictEqual(liveDir(0.05, 0.1), 'flat');
  assert.strictEqual(liveDir(null, 0.1), 'flat');
});

test('parseLive compares with the same hour yesterday', () => {
  const today = '2026-08-21', yday = '2026-08-20';
  const time = [], temp = [], press = [];
  for (const d of [yday, today]) {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      temp.push(d === yday ? 18 : 22);
      press.push(1010);
    }
  }
  const r = parseLive({
    current: { time: `${today}T12:00`, temperature_2m: 22, pressure_msl: 1013, weather_code: 95,
               wind_speed_10m: 14, wind_gusts_10m: 40, precipitation: 0.4 },
    hourly: { time, temperature_2m: temp, pressure_msl: press, wind_speed_10m: Array(48).fill(10), precipitation: Array(48).fill(0) },
  });
  assert.strictEqual(r.temperature.value, 22);
  assert.strictEqual(r.temperature.yesterday, 18);
  assert.strictEqual(r.temperature.delta, 4);
  assert.strictEqual(r.temperature.dir, 'up');
  assert.strictEqual(r.rain.storm, true, 'weather code 95 is a thunderstorm');
  assert.strictEqual(r.pressure.delta, 3);
});

test('parseLive refuses to compare MSL pressure against surface pressure', () => {
  // The v1.2.0 bug: falling back to surface_pressure and differencing it
  // against the MSL hourly series faked a 40 hPa drop.
  const time = [], press = [];
  for (let h = 0; h < 24; h++) { time.push(`2026-08-20T${String(h).padStart(2, '0')}:00`); press.push(1013); }
  const r = parseLive({
    current: { time: '2026-08-21T12:00', surface_pressure: 975, temperature_2m: 20 },
    hourly: { time, pressure_msl: press },
  });
  assert.strictEqual(r.pressure.value, 975, 'the value is still shown');
  assert.strictEqual(r.pressure.delta, null, 'but no comparison is invented');
});

test('parseLive returns null rather than a half-built object', () => {
  assert.strictEqual(parseLive(null), null);
  assert.strictEqual(parseLive({}), null);
});

test('weather code helpers describe and illustrate the sky', () => {
  assert.strictEqual(describeWeather(0), 'Clear');
  assert.strictEqual(describeWeather(95), 'Thunderstorm');
  assert.strictEqual(describeWeather(null), null);
  assert.match(describeWeather(4242), /^Code /, 'an unknown code degrades gracefully');
  assert.strictEqual(weatherIcon(0), '☀️');
  assert.strictEqual(weatherIcon(95), '⛈️');
  assert.strictEqual(weatherIcon(null), '');
});

test('classifiers band their inputs at the documented thresholds', () => {
  assert.strictEqual(classifyPressure(1000), 'Low');
  assert.strictEqual(classifyPressure(1013), 'Normal');
  assert.strictEqual(classifyPressure(1030), 'High');
  assert.strictEqual(classifyWind(10), 'Light');
  assert.strictEqual(classifyWind(30), 'Normal');
  assert.strictEqual(classifyWind(60), 'Strong');
  assert.strictEqual(classifyClouds(5), 'None');
  assert.strictEqual(classifyClouds(90), 'Very high');
  assert.strictEqual(classifyClouds(null), null);
});

// ---- Future ----------------------------------------------------------------

function futureRaw(dates) {
  const time = [], temp = [], cloud = [], press = [];
  for (const d of dates) {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      temp.push(10 + h * 0.5);
      cloud.push(40); press.push(1013);
    }
  }
  return {
    hourly: { time, temperature_2m: temp, cloud_cover: cloud, pressure_msl: press },
    daily: {
      time: dates, weather_code: dates.map(() => 1),
      temperature_2m_max: dates.map(() => 22), temperature_2m_min: dates.map(() => 8),
      shortwave_radiation_sum: dates.map(() => 20), precipitation_sum: dates.map(() => 0),
      wind_gusts_10m_max: dates.map(() => 30),
    },
  };
}

test('parseFuture picks the five labelled hours per day', () => {
  const days = parseFuture(futureRaw(['2026-08-21', '2026-08-22']));
  assert.strictEqual(days.length, 2);
  assert.strictEqual(days[0].label, 'Today');
  assert.strictEqual(days[1].label, 'Tomorrow');
  assert.strictEqual(days[0].temp.h8, 14);
  assert.strictEqual(days[0].temp.h12, 16);
  assert.strictEqual(days[0].temp.h0, 10);
  assert.strictEqual(days[0].clouds.class, 'Medium');
  assert.strictEqual(days[0].weather.desc, 'Mostly clear');
  assert.strictEqual(parseFuture(null).length, 0);
});

test('applyMedianTemps overlays the median series and recomputes max/min', () => {
  // This is the "Graphs and Future show different values" fix.
  const days = parseFuture(futureRaw(['2026-08-21']));
  assert.strictEqual(days[0].temp.h12, 16, 'best_match value before the overlay');

  const map = {};
  for (let h = 0; h < 24; h++) map[`2026-08-21T${String(h).padStart(2, '0')}:00`] = 25 + h * 0.1;
  applyMedianTemps(days, map);

  assert.strictEqual(days[0].temp.h12, 26.2, 'the median value wins');
  assert.strictEqual(days[0].tempMax, 27.3, 'max is recomputed FROM the median series');
  assert.strictEqual(days[0].tempMin, 25, 'so the daily figures cannot contradict the hourly ones');
});

test('applyMedianTemps leaves days the median cannot reach untouched', () => {
  const days = parseFuture(futureRaw(['2026-08-21', '2026-09-30']));
  const before = { ...days[1].temp };
  applyMedianTemps(days, { '2026-08-21T12:00': 30 });
  assert.deepStrictEqual(days[1].temp, before, 'beyond the model horizon, best_match stands');
  assert.strictEqual(days[0].temp.h12, 30);
  // Too few hours to trust a recomputed max/min.
  assert.strictEqual(days[0].tempMax, 22, 'daily max is not rebuilt from a single hour');
});

test('buildNotes fires on the swings that matter and stays quiet otherwise', () => {
  const base = {
    tempMax: 20, tempMin: 10, clouds: { meanPct: 40 }, pressure: { value: 1013 },
    solar: { radSum: 20 }, weather: { code: 1 }, precipSum: 0, wind: { gustMax: 20 },
  };
  assert.deepStrictEqual(buildNotes(null, base), [], 'a calm day with no previous day says nothing');

  const warmer = { ...base, tempMax: 28 };
  assert.ok(buildNotes(base, warmer).some(n => /Much warmer/.test(n)));

  const clearing = { ...base, clouds: { meanPct: 2 }, solar: { radSum: 28 } };
  const notes = buildNotes(base, clearing);
  assert.ok(notes.some(n => /Clearing up/.test(n)));
  assert.ok(notes.some(n => /Stronger solar/.test(n)));

  const nasty = { ...base, weather: { code: 95 }, precipSum: 20, wind: { gustMax: 70 }, tempMin: -3 };
  const bad = buildNotes(base, nasty);
  assert.ok(bad.some(n => /Storm risk/.test(n)));
  assert.ok(bad.some(n => /Heavy rain/.test(n)));
  assert.ok(bad.some(n => /Strong winds/.test(n)));
  assert.ok(bad.some(n => /Frost/.test(n)));
});
