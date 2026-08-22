'use strict';
// The market brief is ~250 lines of thresholds and weighted averages that
// produce something a trader acts on. v2.0 tested none of it.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/features/market');
const { config } = require('../src/config');

const CFG = config.market;

test('windPowerAt implements the turbine curve, including cut-out', () => {
  assert.strictEqual(M.windPowerAt(5), 0, 'below cut-in');
  assert.strictEqual(M.windPowerAt(10.9), 0, 'just below cut-in');
  assert.strictEqual(M.windPowerAt(43), 1, 'at rated');
  assert.strictEqual(M.windPowerAt(60), 1, 'above rated but below cut-out');
  assert.strictEqual(M.windPowerAt(90), 0, 'AT cut-out the turbine stops');
  assert.strictEqual(M.windPowerAt(120), 0, 'well above cut-out');
  assert.strictEqual(M.windPowerAt(null), null);
  assert.strictEqual(M.windPowerAt('breezy'), null);
  const mid = M.windPowerAt(30);
  assert.ok(mid > 0 && mid < 1, 'the ramp is between 0 and 1');
});

test('windPowerIndex averages the curve, not the wind speed', () => {
  // Half the day dead calm, half at rated -> 50%.
  const speeds = [...Array(12).fill(2), ...Array(12).fill(50)];
  assert.strictEqual(M.windPowerIndex(speeds), 0.5);
  assert.strictEqual(M.windPowerIndex([]), null);
  assert.strictEqual(M.windPowerIndex(null), null);
  // A storm-force day produces NOTHING, even though the wind is huge.
  assert.strictEqual(M.windPowerIndex(Array(24).fill(100)), 0);
});

test('solarIndex normalises against the right month and clamps to 1', () => {
  const june = M.solarIndex(29, 5);              // June max is 29
  assert.strictEqual(june, 1);
  assert.strictEqual(M.solarIndex(50, 5), 1, 'clamped, never above 100%');
  assert.strictEqual(M.solarIndex(0, 5), 0);
  // The same radiation is a much better day in December than in June.
  assert.ok(M.solarIndex(5, 11) > M.solarIndex(5, 5));
  assert.strictEqual(M.solarIndex(null, 5), null);
});

test('degreeDays splits heating and cooling at the configured bases', () => {
  assert.deepStrictEqual(M.degreeDays(10, 0), { mean: 5, hdd: 13, cdd: 0 });
  assert.deepStrictEqual(M.degreeDays(30, 20), { mean: 25, hdd: 0, cdd: 4 });
  // Between the two bases is the "mild" band: neither heating nor cooling.
  assert.deepStrictEqual(M.degreeDays(24, 16), { mean: 20, hdd: 0, cdd: 0 });
  assert.deepStrictEqual(M.degreeDays(null, 5), { mean: null, hdd: null, cdd: null });
});

test('signalDir respects its thresholds exactly', () => {
  assert.strictEqual(M.signalDir(10, 10, -10), 'up');
  assert.strictEqual(M.signalDir(9.9, 10, -10), 'flat');
  assert.strictEqual(M.signalDir(-10, 10, -10), 'down');
  assert.strictEqual(M.signalDir(null, 10, -10), null);
});

test('residualLoad points the right way for each driver in isolation', () => {
  // More renewables, flat demand -> softer.
  const softer = M.residualLoad(30, 20, 0);
  assert.strictEqual(softer.direction, 'softer');
  assert.ok(softer.score < 0);

  // Renewables collapse, demand climbs -> tighter.
  const tighter = M.residualLoad(-30, -20, 3);
  assert.strictEqual(tighter.direction, 'tighter');
  assert.ok(tighter.score > 0);

  // Nothing much moves -> neutral, and no driver chips are emitted.
  const neutral = M.residualLoad(1, -2, 0.1);
  assert.strictEqual(neutral.direction, 'neutral');
  assert.deepStrictEqual(neutral.drivers, []);

  // No inputs at all is 'unknown', not a confident 'neutral'.
  assert.strictEqual(M.residualLoad(null, null, null).direction, 'unknown');
});

test('residualLoad labels each driver with the direction it pushes', () => {
  const r = M.residualLoad(-46, 56, -4);
  const by = Object.fromEntries(r.drivers.map(d => [d.key, d.effect]));
  assert.strictEqual(by.solar, 'tighter', 'less sun tightens');
  assert.strictEqual(by.wind, 'softer', 'more wind softens');
  assert.strictEqual(by.demand, 'softer', 'falling degree days soften');
  assert.ok(['slight', 'moderate', 'strong'].includes(r.strength));
});

test('residualLoad score is clamped to +/-100', () => {
  assert.strictEqual(M.residualLoad(-100, -100, 50).score, 100);
  assert.strictEqual(M.residualLoad(100, 100, -50).score, -100);
});

test('parseMarketCity extracts per-day metrics and hazard flags', () => {
  const date = '2026-08-21';
  const time = [], wind = [], code = [], cloud = [];
  for (let h = 0; h < 24; h++) {
    time.push(`${date}T${String(h).padStart(2, '0')}:00`);
    wind.push(h === 15 ? 95 : 30);                 // one cut-out hour
    code.push(h === 6 ? 45 : (h === 16 ? 95 : 1)); // morning fog + an afternoon storm
    cloud.push(50);
  }
  const raw = {
    hourly: { time, wind_speed_120m: wind, weather_code: code, cloud_cover: cloud },
    daily: {
      time: [date], temperature_2m_max: [31], temperature_2m_min: [12],
      shortwave_radiation_sum: [20], precipitation_sum: [18],
      wind_gusts_10m_max: [110], weather_code: [95],
    },
  };
  const [day] = M.parseMarketCity(raw);
  assert.strictEqual(day.date, date);
  assert.strictEqual(day.stormy, true);
  assert.strictEqual(day.stormHours, 1);
  assert.strictEqual(day.fogMorning, true, 'fog at 06:00 counts as morning fog');
  assert.strictEqual(day.snow, false);
  assert.strictEqual(day.gustCutoutHours, 1);
  assert.strictEqual(day.gustMax, 110);
  assert.strictEqual(day.cloudDaytimePct, 50);
  assert.strictEqual(day.dd.cdd > 0, true, '31/12 means a mean of 21.5, above the CDD base');
  assert.strictEqual(M.parseMarketCity(null).length, 0);
});

test('parseMarketCity only counts fog inside the morning window', () => {
  const date = '2026-08-21';
  const time = [], code = [];
  for (let h = 0; h < 24; h++) { time.push(`${date}T${String(h).padStart(2, '0')}:00`); code.push(h === 20 ? 45 : 1); }
  const [day] = M.parseMarketCity({
    hourly: { time, weather_code: code },
    daily: { time: [date], temperature_2m_max: [20], temperature_2m_min: [10] },
  });
  assert.strictEqual(day.fogMorning, false, 'evening fog does not delay a solar ramp');
});

// ---- country brief ---------------------------------------------------------

function day(date, o) {
  return Object.assign({
    date, tmax: 20, tmin: 10, dd: { mean: 15, hdd: 3, cdd: 0 }, radSum: 18,
    solarIdx: 0.7, windMean: 25, windIdx: 0.35, windPeak: 40, gustMax: 45,
    gustCutoutHours: 0, precipSum: 0, cloudDaytimePct: 40, weatherCode: 1,
    stormHours: 0, stormy: false, fogMorning: false, snow: false,
  }, o);
}
const FOUR = [day('2026-08-20'), day('2026-08-21'), day('2026-08-22'), day('2026-08-23')];

test('buildMarketBrief weights cities by population', () => {
  const hot = FOUR.map(d => ({ ...d, tmax: 30 }));
  const cold = FOUR.map(d => ({ ...d, tmax: 10 }));
  const brief = M.buildMarketBrief('CZ', [
    { city: 'Prague', weight: 3, days: hot },
    { city: 'Brno', weight: 1, days: cold },
  ]);
  // (30*3 + 10*1) / 4 = 25 — not the unweighted mean of 20.
  assert.strictEqual(brief.days[0].tempMax, 25);
});

test('buildMarketBrief marks yesterday as context and gives it no residual call', () => {
  const brief = M.buildMarketBrief('CZ', [{ city: 'Prague', weight: 1, days: FOUR }]);
  assert.strictEqual(brief.days[0].label, 'Yesterday');
  assert.strictEqual(brief.days[0].context, true);
  assert.strictEqual(brief.days[0].residual, null, 'context days get no signal');
  assert.strictEqual(brief.days[1].label, 'Today');
  assert.ok(brief.days[1].residual, 'every non-context day gets one');
});

test('buildMarketBrief emits typed risk objects with severities', () => {
  const days = [
    day('2026-08-20'),
    day('2026-08-21', { tmax: 33, tmin: 20 }),
    day('2026-08-22', { stormy: true, stormHours: 4, gustMax: 96, precipSum: 22 }),
    day('2026-08-23', { tmin: -2, snow: true, fogMorning: true, gustMax: 75 }),
  ];
  const brief = M.buildMarketBrief('CZ', [{ city: 'Prague', weight: 1, days }]);
  const ids = d => d.risks.map(r => r.id);

  assert.ok(ids(brief.days[1]).includes('heat'));
  assert.ok(ids(brief.days[2]).includes('storm'));
  assert.ok(ids(brief.days[2]).includes('cutout'), '96 km/h is at or above the 90 cut-out');
  assert.ok(ids(brief.days[2]).includes('rain'));
  assert.ok(ids(brief.days[3]).includes('frost'));
  assert.ok(ids(brief.days[3]).includes('snow'));
  assert.ok(ids(brief.days[3]).includes('fog'));
  assert.ok(ids(brief.days[3]).includes('gusts'), '75 km/h is strong but below cut-out');
  assert.ok(!ids(brief.days[3]).includes('cutout'));

  for (const r of brief.days[2].risks) {
    assert.ok(['high', 'medium', 'low'].includes(r.severity), `${r.id} needs a severity`);
    assert.ok(r.detail && r.detail.length > 20, `${r.id} needs a hover explanation`);
    assert.ok(r.icon && r.label, `${r.id} needs an icon and a label`);
  }
});

test('buildMarketBrief headline surfaces tomorrow and its worst risk', () => {
  const days = [
    day('2026-08-20'), day('2026-08-21'),
    day('2026-08-22', { stormy: true, stormHours: 3, precipSum: 20, solarIdx: 0.2 }),
    day('2026-08-23'),
  ];
  const brief = M.buildMarketBrief('CZ', [{ city: 'Prague', weight: 1, days }]);
  assert.strictEqual(brief.headline.day, 'Tomorrow');
  assert.strictEqual(brief.headline.topRisk.id, 'storm', 'high severity outranks the low-severity rain');
  assert.ok(brief.headline.residual);
});

test('buildMarketBrief drops cities with no data and refuses an empty set', () => {
  const brief = M.buildMarketBrief('CZ', [
    { city: 'Prague', weight: 1, days: FOUR },
    { city: 'Brno', weight: 1, days: [] },
  ]);
  assert.strictEqual(brief.cities.length, 1);
  assert.strictEqual(M.buildMarketBrief('CZ', []), null);
  assert.strictEqual(M.buildMarketBrief('XX', [{ city: 'Prague', weight: 1, days: FOUR }]), null);
});

test('every configured market city exists in the city list', () => {
  const names = config.cities.map(c => c.name);
  for (const [code, country] of Object.entries(CFG.COUNTRIES)) {
    for (const c of country.cities) {
      assert.ok(names.includes(c.name), `${code} references unknown city ${c.name}`);
    }
  }
});
