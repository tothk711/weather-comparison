// ---------------------------------------------------------------------------
// Future tab — one tab, both countries: Czechia on top, Hungary underneath.
//
// v2.0 had these as two separate tabs whose labels were both just "future" with
// a flag, so telling them apart meant reading the flag. One tab, two stacked
// cards, and both come from one request.
//
// The temperatures here are the SAME global-median series the Graphs draw, so
// the two tabs can no longer show different numbers for the same hour.
// ---------------------------------------------------------------------------

import { getJson } from './api.js';
import { tipAttr } from './tooltip.js';
import { esc, isNum, weekdayName, FLAGS, el, localTime, pick } from './util.js';

const TIPS = {
  temp: 'Air temperature at this hour, in °C — the per-hour median across the models (the same series the Graphs tab draws).',
  tempNight: 'Air temperature around midnight, in °C.',
  pressure: 'Air pressure near midday — Low / Normal / High. Falling pressure usually means more unsettled weather is coming.',
  wind: 'The strongest wind gusts expected that day — Light (<20), Normal (20-50), Strong (50+ km/h).',
  weather: 'Overall sky condition for the day, from the Open-Meteo weather code.',
  clouds: 'Average cloud cover over the day, None → Very high. Fewer clouds means more solar.',
  solar: 'Total solar energy reaching the ground that day (shortwave radiation, MJ/m²). This is what drives photovoltaic output: about 25 is a sunny summer day, single digits mean dull or overcast.',
  note: 'Automatic flags from the data — big temperature or cloud swings, storms, strong wind, frost, heavy rain.',
  colour: 'Cell colour compares the day with the one before it, from the point of view of solar (FVE) output: green = moving toward more generation, red = away from it.',
};

// Colour class for a day-over-day change.
//   goodUp true  -> an increase is good for solar
//   goodUp false -> a decrease is good for solar
function swingClass(curr, prev, goodUp, t1, t2) {
  if (!isNum(curr) || !isNum(prev)) return '';
  const delta = goodUp ? (curr - prev) : (prev - curr);
  if (delta >= t2) return 'swing-vg';
  if (delta >= t1) return 'swing-g';
  if (delta <= -t2) return 'swing-dr';
  if (delta <= -t1) return 'swing-r';
  return '';
}

function cell(value, suffix, cls) {
  if (value === null || value === undefined || value === '') return '<td class="blank">—</td>';
  return `<td class="${cls || ''}">${esc(value)}${suffix || ''}</td>`;
}

function renderCountry(data) {
  const days = data.days || [];
  const flag = pick(FLAGS, data.country);
  const round = v => (isNum(v) ? Math.round(v) : null);
  const prevOf = i => (i > 0 ? days[i - 1] : null);

  const head = days.map(d => {
    const wd = weekdayName(d.date);
    return `<th>${esc(d.label)}<span class="col-date">${esc(d.date || '')}</span>`
      + (wd ? `<span class="col-day">${esc(wd)}</span>` : '') + '</th>';
  }).join('');

  const label = (text, tip, title) =>
    `<th class="row-label has-tip"${tipAttr(tip, title)}>${text}</th>`;

  const tempRow = (text, key, tip) => {
    let row = label(text, tip, 'Temperature');
    days.forEach((d, i) => {
      const p = prevOf(i);
      row += cell(round(d.temp[key]), '°', p ? swingClass(d.temp[key], p.temp[key], true, 2.5, 6) : '');
    });
    return `<tr>${row}</tr>`;
  };

  const textRow = (text, fn, tip, title) => {
    let row = label(text, tip, title);
    days.forEach(d => { row += cell(fn(d), '', ''); });
    return `<tr>${row}</tr>`;
  };

  let cloudsRow = label('☁️ Clouds', TIPS.clouds, 'Cloud cover');
  days.forEach((d, i) => {
    const p = prevOf(i);
    cloudsRow += cell(d.clouds.class, '', p ? swingClass(d.clouds.meanPct, p.clouds.meanPct, false, 12, 30) : '');
  });

  let solarRow = label('☀️ Solar (FVE)', TIPS.solar, 'Solar potential');
  days.forEach((d, i) => {
    const p = prevOf(i);
    solarRow += cell(round(d.solar.radSum), '', p ? swingClass(d.solar.radSum, p.solar.radSum, true, 3, 8) : '');
  });

  let noteRow = label('📝 Note', TIPS.note, 'Automatic notes');
  days.forEach(d => {
    const notes = (d.notes || []).slice(0, 3).join('; ');
    noteRow += notes ? `<td class="prep-note">${esc(notes)}</td>` : '<td class="blank">—</td>';
  });

  const srcNote = data.source === 'median'
    ? `Global median of ${(data.models || []).length} models`
    : 'Open-Meteo best-match only';

  return `
    <div class="panel">
      <div class="panel-title">${flag} ${esc(data.name || data.country)} — 6-day outlook <span style="color:#6b7c93;font-weight:500;">(${esc(data.capital)} as country proxy)</span></div>
      <div class="panel-sub">Temperatures: ${esc(srcNote)} · other rows from Open-Meteo · generated ${esc(localTime(data.generatedAt))}</div>
      <div class="table-scroll">
        <table class="box">
          <thead><tr><th class="row-label">${flag} ${esc(data.country)}</th>${head}</tr></thead>
          <tbody>
            ${tempRow('🌡️ Temp 8:00', 'h8', TIPS.temp)}
            ${tempRow('🌡️ Temp 12:00', 'h12', TIPS.temp)}
            ${tempRow('🌡️ Temp 16:00', 'h16', TIPS.temp)}
            ${tempRow('🌡️ Temp 20:00', 'h20', TIPS.temp)}
            ${tempRow('🌡️ Temp 0:00', 'h0', TIPS.tempNight)}
            ${textRow('🎚️ Pressure', d => d.pressure.class, TIPS.pressure, 'Pressure')}
            ${textRow('💨 Wind', d => d.wind.class, TIPS.wind, 'Wind gusts')}
            ${textRow('⚡ Weather', d => `${d.weather.icon || ''} ${d.weather.desc || ''}`.trim(), TIPS.weather, 'Weather')}
            <tr>${cloudsRow}</tr>
            <tr>${solarRow}</tr>
            <tr>${noteRow}</tr>
          </tbody>
        </table>
      </div>
      <div class="legend-note">
        <span class="has-tip"${tipAttr(TIPS.colour, 'Cell colour')}><strong>Colour = change vs the previous day, for solar (FVE) output.</strong></span>
        <span class="swatch swing-vg"></span> much higher
        <span class="swatch swing-g"></span> higher
        <span class="swatch swing-r"></span> lower
        <span class="swatch swing-dr"></span> much lower
      </div>
    </div>`;
}

export async function loadFuture(source) {
  const wrap = el('futureView');
  if (!wrap.innerHTML.trim()) wrap.innerHTML = '<div class="loading">Loading the 6-day outlook…</div>';
  try {
    const data = await getJson(`/api/future?source=${encodeURIComponent(source)}`);
    const cards = (data.countries || []).map(renderCountry);
    wrap.innerHTML = cards.length
      ? `<div class="stack">${cards.join('')}</div>`
      : '<div class="error">Could not load the outlook.</div>';
  } catch (e) {
    console.error('Future load failed:', e);
    wrap.innerHTML = '<div class="error">Could not load the 6-day outlook.</div>';
  }
}
