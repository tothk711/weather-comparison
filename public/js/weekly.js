// ---------------------------------------------------------------------------
// Weekly tab (renamed from "History" in v3.0 — it has always shown forecasts as
// well as actuals, so "History" was the wrong word for it).
//
// 24 rows × 7 day columns for one ISO week. Weeks are addressed by year AND
// number now, so December is reachable from January.
// ---------------------------------------------------------------------------

import { getJson } from './api.js';
import { tipAttr } from './tooltip.js';
import {
  esc, isNum, fmtTemp, hh, weekdayName, shortDate, appToday,
  heatColor, heatColorLight, el, localTime,
} from './util.js';

const TIPS = {
  city: 'Which city this grid covers.',
  week: 'ISO week (Monday to Sunday). The list runs back about 18 months and forward two weeks — weeks are addressed by year, so you can read last December from January.',
  source: 'Global median = per-hour median across the models. Openmeteo = the single best-match model. Defaults to the same source as the Graphs tab.',
  dec: 'Decimal places — click to cycle 0 / 1 / 2.',
  cells: 'Dark cell with white text = the hour already happened. Light cell with dark italic text = a model forecast. A dash means the hour is beyond the models’ ~16-day horizon.',
  colour: 'Colour is scaled to THIS week only: dark green is the coldest hour of the week, dark red the warmest. It shows shape within the week, not an absolute temperature scale.',
};

let city = 'Prague';
let year = null;
let week = null;
let source = 'median';
let decimals = 0;
let last = null;
let weekList = [];

export function initWeekly(cfg, defaultSource) {
  source = defaultSource || 'median';
  const cities = cfg.cities.map(c => c.name);
  weekList = (cfg.weekly && cfg.weekly.weeks) || [];
  const current = cfg.weekly && cfg.weekly.current;
  if (current) { year = current.year; week = current.week; }

  const cs = el('weeklyCity');
  cs.innerHTML = cities.map(c => `<option value="${esc(c)}"${c === city ? ' selected' : ''}>${esc(c)}</option>`).join('');
  cs.setAttribute('data-tip', TIPS.city);
  cs.addEventListener('change', e => { city = e.target.value; load(); });

  const ws = el('weeklyWeek');
  ws.innerHTML = weekList.slice().reverse().map(w => {
    const tag = w.tag === 'current' ? ' — current' : (w.tag === 'upcoming' ? ' — upcoming' : '');
    const sel = (w.year === year && w.week === week) ? ' selected' : '';
    // These come from /api/config; escaped anyway — `value=` is an attribute,
    // and an unescaped year there could break out of the quotes.
    const y = esc(w.year), n = esc(String(w.week).padStart(2, '0'));
    return `<option value="${y}-${esc(w.week)}"${sel}>${y}-W${n} (${esc(shortDate(w.start))} – ${esc(shortDate(w.end))})${tag}</option>`;
  }).join('');
  ws.setAttribute('data-tip', TIPS.week);
  ws.setAttribute('data-tip-title', 'Week');
  ws.addEventListener('change', e => {
    const [y, w] = e.target.value.split('-').map(Number);
    year = y; week = w; load();
  });

  const ss = el('weeklySource');
  ss.value = source;
  ss.setAttribute('data-tip', TIPS.source);
  ss.setAttribute('data-tip-title', 'Data source');
  ss.addEventListener('change', e => { source = e.target.value; load(); });

  const dec = el('weeklyDec');
  dec.setAttribute('data-tip', TIPS.dec);
  dec.addEventListener('click', () => {
    decimals = (decimals + 1) % 3;
    dec.textContent = `Dec ${decimals}`;
    if (last) render(last);
  });
}

// Keep in step when the Graphs source selector changes.
export function setWeeklySource(next) {
  source = next;
  const ss = el('weeklySource');
  if (ss) ss.value = next;
  if (last) load();
}

export async function load() {
  if (year === null || week === null) return;
  const container = el('weeklyContainer');
  container.innerHTML = '<div class="loading">Loading the week…</div>';
  el('weeklyLegend').innerHTML = '';
  try {
    const data = await getJson(
      `/api/weekly/${encodeURIComponent(city)}?year=${year}&week=${week}&source=${encodeURIComponent(source)}`);
    render(data);
  } catch (e) {
    console.error('Weekly load failed:', e);
    container.innerHTML = `<div class="error">${esc(e.message || 'Could not load this week.')}</div>`;
  }
}

function render(data) {
  last = data;
  const today = appToday();

  let html = `<table class="grid"><caption>${esc(data.city)} — ${esc(data.year)}-W${esc(String(data.week).padStart(2, '0'))} `
    + `(${esc(data.start)} → ${esc(data.end)}) · ${data.source === 'median' ? 'Global median' : 'Openmeteo'} (°C, CET/CEST)</caption>`
    + '<thead><tr><th class="time-col">Time</th>';
  for (const d of data.days) {
    const isToday = d === today;
    html += `<th class="${isToday ? 'today-col' : ''}">${esc(weekdayName(d, true))}${isToday ? ' · today' : ''}`
      + `<span class="sub">${esc(d)}</span></th>`;
  }
  html += '</tr></thead><tbody>';

  const vals = [];
  data.temps.forEach(row => row.forEach(v => { if (isNum(v)) vals.push(v); }));
  const vMin = vals.length ? Math.min(...vals) : 0;
  const vMax = vals.length ? Math.max(...vals) : 0;
  const cut = data.cutoff || { date: today, hour: 23 };
  const isForecast = (d, h) => d > cut.date || (d === cut.date && h > cut.hour);

  for (let h = 0; h < 24; h++) {
    html += `<tr><td class="time-col">${hh(h)}</td>`;
    for (let d = 0; d < 7; d++) {
      const v = data.temps[h][d];
      if (!isNum(v)) { html += '<td class="na">—</td>'; continue; }
      html += isForecast(data.days[d], h)
        ? `<td style="background:${heatColorLight(v, vMin, vMax)};color:#0d1520;font-style:italic;font-weight:600;">${fmtTemp(v, decimals)}</td>`
        : `<td style="background:${heatColor(v, vMin, vMax)};color:#f5f7f9;font-weight:600;">${fmtTemp(v, decimals)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  el('weeklyContainer').innerHTML = html;

  const names = (data.sources || []).map(s => esc(s.label)).join(', ');
  const sw = h => `<span class="swatch" style="background:hsl(${h},62%,30%)"></span>`;
  el('weeklyLegend').innerHTML =
    `<span class="has-tip"${tipAttr(TIPS.colour, 'Colour scale')}><strong>Colour = position within this week's range:</strong></span> `
    + `${sw(120)} coldest (${fmtTemp(vals.length ? vMin : null, decimals)}) ${sw(60)} middle ${sw(0)} warmest (${fmtTemp(vals.length ? vMax : null, decimals)})<br>`
    + `<span class="has-tip"${tipAttr(TIPS.cells, 'Cell styles')}><strong>Dark = already happened · light italic = model forecast · — = beyond the horizon.</strong></span><br>`
    + (data.source === 'median'
        ? `Median of the sources covering this location: ${names || 'none'}.`
        : 'Open-Meteo best-match model only.')
    + `<div class="note">Data: Open-Meteo ${esc(data.endpoint)}. Generated ${esc(localTime(data.generatedAt))}.</div>`;
}
