// ---------------------------------------------------------------------------
// Market tab — v3.0 redesign.
//
// The v2.0 tab had the right idea and the wrong execution: a sentence in every
// cell, pre-formatted emoji strings for risks, and a paragraph of legend under
// the table explaining what any of it meant. You had to READ it to use it.
//
// This version answers three questions before you read anything:
//   1. Is tomorrow's residual load tighter or softer, and by how much?
//   2. What could go wrong, and how confident is the forecast?
//   3. Where are solar and wind, in numbers?
//
// Everything explanatory now lives in a hover, not on the page.
// ---------------------------------------------------------------------------

import { getJson } from './api.js';
import { tipAttr } from './tooltip.js';
import { esc, isNum, fx, fnum, weekdayName, shortDate, FLAGS, el, localTime, pick } from './util.js';

const TIPS = {
  residual: 'Residual load is demand minus what sun and wind cover — the part the market has to price. Renewables push it DOWN (softer), temperature-driven demand pushes it UP (tighter). The score combines the day-over-day change in the solar index, the wind index and degree days; ±10 is the threshold for calling a direction, ±35 for calling it strong. Fundamentals only — this is not a price forecast.',
  solar: 'Daily solar energy total, normalised 0–100% against a clear-sky maximum for this month. 100% would be a cloudless day; the arrow and pp figure compare with the previous day. Higher = more photovoltaic generation.',
  wind: 'Hourly wind speed at roughly 120 m hub height, pushed through a simplified turbine power curve (cut-in 11, rated 43, cut-out 90 km/h) and averaged over the day, 0–100%. Higher = more wind generation.',
  demand: 'Population-weighted temperature across the country’s cities. HDD = heating degree days (how far the daily mean sits below 18 °C); CDD = cooling degree days (above 21 °C). A bigger number means more temperature-driven load.',
  risks: 'Grid-relevant weather hazards. Red = high impact (storms, turbine cut-out gusts, heat), amber = medium (strong gusts, morning fog, snow, frost), blue = low (heavy rain). Hover any chip for what it means.',
  stability: 'How much you can trust the forecast underneath all of this. Δ is how far the capital-city temperature forecast has moved since yesterday’s model run — 1.5 °C or more is a market-moving revision. ± is the mean disagreement between the independent models: tight means they see the same weather, wide means forecast risk.',
  weather: 'Overall sky condition for the day, from the Open-Meteo weather code.',
  ctx: 'Yesterday is shown for context. It already happened — it is not a signal.',
};

const SEV_RANK = { high: 0, medium: 1, low: 2 };

function bar(kind, pct) {
  if (!isNum(pct)) return '';
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="bar ${kind}"><i style="width:${w}%"></i></div>`;
}

function deltaChip(v, unit = 'pp') {
  if (!isNum(v)) return '';
  const cls = v >= 10 ? 'up' : (v <= -10 ? 'down' : 'flat');
  const arrow = v >= 10 ? '▲' : (v <= -10 ? '▼' : '▬');
  return `<span class="delta ${cls}">${arrow} ${v > 0 ? '+' : ''}${v}${unit}</span>`;
}

function riskChip(r) {
  return `<span class="risk risk-${esc(r.severity)}"${tipAttr(r.detail, r.label)}>`
    + `${esc(r.icon)} ${esc(r.label)}${r.value ? ` <span class="rv">${esc(r.value)}</span>` : ''}</span>`;
}

function verdictBadge(res) {
  if (!res || res.direction === 'unknown') {
    return `<span class="verdict unknown">— no read</span>`;
  }
  const word = pick({ tighter: 'TIGHTER', softer: 'SOFTER', neutral: 'FLAT' }, res.direction, '—');
  const arrow = pick({ tighter: '▲', softer: '▼', neutral: '▬' }, res.direction, '');
  const score = isNum(res.score) ? ` ${res.score > 0 ? '+' : ''}${res.score}` : '';
  return `<span class="verdict ${esc(res.direction)}"${tipAttr(res.summary + ' ' + TIPS.residual, 'Residual load')}>${arrow} ${word}${score}</span>`;
}

function driverChips(res) {
  if (!res || !res.drivers || !res.drivers.length) return '';
  return `<div class="drivers">${res.drivers.map(d =>
    `<span class="driver ${esc(d.effect)}">${esc(d.label)} ${esc(d.value)}</span>`).join('')}</div>`;
}

// ---- the four headline tiles ------------------------------------------------

function tiles(brief) {
  const h = brief.headline || {};
  const day = (brief.days || []).find(d => d.label === h.day) || {};
  const res = h.residual || {};
  const dir = res.direction || 'unknown';
  const word = pick({ tighter: 'Tighter', softer: 'Softer', neutral: 'Flat', unknown: '—' }, dir, '—');
  const topRisk = h.topRisk;

  return `<div class="mk-tiles">
    <div class="tile ${esc(dir)}"${tipAttr(res.summary ? `${res.summary} ${TIPS.residual}` : TIPS.residual, 'Residual load')}>
      <div class="k">Residual load</div>
      <div class="v">${esc(word)}</div>
      <div class="d">${isNum(res.score) ? `score ${res.score > 0 ? '+' : ''}${res.score} · ${esc(res.strength || '')}` : 'no read'}</div>
    </div>
    <div class="tile"${tipAttr(TIPS.risks, 'Risk and confidence')}>
      <div class="k">Top risk</div>
      <div class="v" style="font-size:1.02rem;">${topRisk ? `${esc(topRisk.icon)} ${esc(topRisk.label)}` : 'None flagged'}</div>
      <div class="d">${topRisk ? esc(topRisk.value || topRisk.severity) : 'no hazards in the window'}</div>
    </div>
    <div class="tile"${tipAttr(TIPS.solar, 'Solar generation')}>
      <div class="k">Solar</div>
      <div class="v">${isNum(h.solarIndex) ? `${h.solarIndex}%` : '—'} ${deltaChip(day.deltas && day.deltas.solar)}</div>
      ${bar('solar', h.solarIndex)}
      <div class="d">${isNum(day.solar && day.solar.sumMJ) ? `${Math.round(day.solar.sumMJ)} MJ/m²` : ''}${isNum(day.solar && day.solar.cloudPct) ? ` · cloud ${day.solar.cloudPct}%` : ''}</div>
    </div>
    <div class="tile"${tipAttr(TIPS.wind, 'Wind generation')}>
      <div class="k">Wind</div>
      <div class="v">${isNum(h.windIndex) ? `${h.windIndex}%` : '—'} ${deltaChip(day.deltas && day.deltas.wind)}</div>
      ${bar('wind', h.windIndex)}
      <div class="d">${isNum(day.wind && day.wind.meanKmh) ? `⌀ ${Math.round(day.wind.meanKmh)} km/h @120m` : ''}${isNum(day.wind && day.wind.gustMax) ? ` · gust ${day.wind.gustMax}` : ''}</div>
    </div>
  </div>`;
}

function stabilityStrip(s) {
  if (!s) return '';
  const rev = s.revision && (s.revision.tomorrow || s.revision.today);
  const spread = s.modelSpread || {};
  const bits = [];
  if (rev && isNum(rev.avg)) {
    const hot = Math.abs(rev.avg) >= 1.5;
    bits.push(`<span${hot ? ' class="rev-hot"' : ''}>Δ <b>${rev.avg > 0 ? '+' : ''}${fx(rev.avg)}°</b> vs yesterday's run</span>`);
  }
  if (isNum(spread.tomorrow)) bits.push(`models <b>±${fx(spread.tomorrow)}°</b> tomorrow`);
  else if (isNum(spread.today)) bits.push(`models <b>±${fx(spread.today)}°</b> today`);
  if (isNum(s.correctedHours) && s.correctedHours > 0) bits.push(`🛠 ${fnum(s.correctedHours)} hr corrected`);
  if (isNum(s.suspectHours) && s.suspectHours > 0) bits.push(`⚠ ${fnum(s.suspectHours)} hr flagged`);
  if (!bits.length) return '';
  return `<div class="stability-strip has-tip"${tipAttr(TIPS.stability, 'Forecast stability')}>`
    + `<span class="lab">Forecast stability</span><span class="cap">${esc(s.capital)}</span>`
    + bits.join(' <span style="color:#4c5875">·</span> ') + '</div>';
}

// ---- the 4-day table --------------------------------------------------------

function dayTable(brief) {
  const days = brief.days || [];
  const head = days.map(d => {
    const wd = weekdayName(d.date, true);
    return `<th class="${d.context ? 'ctx' : ''}"${d.context ? tipAttr(TIPS.ctx, 'Yesterday') : ''}>${esc(d.label)}`
      + (d.context ? '<span class="actual-tag">ACTUAL</span>' : '')
      + `<span class="col-date">${esc(shortDate(d.date))}</span>`
      + (wd ? `<span class="col-day">${esc(wd)}</span>` : '') + '</th>';
  }).join('');

  const row = (label, tip, title, fn) => {
    let r = `<th class="row-label has-tip"${tipAttr(tip, title)}>${label}</th>`;
    for (const d of days) r += `<td class="${d.context ? 'ctx' : ''}">${fn(d)}</td>`;
    return `<tr>${r}</tr>`;
  };

  const weatherCell = d => (d.weather && d.weather.desc)
    ? `<span class="mk-big" style="font-size:1.3rem;line-height:1;">${esc(d.weather.icon || '')}</span><span class="mk-sub">${esc(d.weather.desc)}</span>`
    : '<span class="mk-sub">—</span>';

  const demandCell = d => {
    if (!isNum(d.tempMax) && !isNum(d.tempMin)) return '<span class="mk-big">—</span>';
    let html = `<span class="mk-big">${isNum(d.tempMax) ? `${Math.round(d.tempMax)}°` : '—'}</span>`;
    html += `<span class="mk-sub">min ${isNum(d.tempMin) ? `${Math.round(d.tempMin)}°` : '—'}${isNum(d.deltas && d.deltas.tempMax) ? ` · ${d.deltas.tempMax > 0 ? '+' : ''}${d.deltas.tempMax}° vs prev` : ''}</span>`;
    const hdd = isNum(d.hdd) ? d.hdd : 0, cdd = isNum(d.cdd) ? d.cdd : 0;
    if (cdd > hdd && cdd > 0) html += `<span class="mk-dd cool">CDD ${fx(cdd)}</span>`;
    else if (hdd > 0) html += `<span class="mk-dd heat">HDD ${fx(hdd)}</span>`;
    else html += '<span class="mk-dd none">mild</span>';
    return html;
  };

  const solarCell = d => {
    const s = d.solar || {};
    if (!isNum(s.index)) return '<span class="mk-big">—</span>';
    return `<span class="mk-big">${s.index}%</span> ${deltaChip(d.deltas && d.deltas.solar)}${bar('solar', s.index)}`
      + `<span class="mk-sub">${isNum(s.sumMJ) ? `${Math.round(s.sumMJ)} MJ/m²` : ''}${isNum(s.cloudPct) ? ` · cloud ${s.cloudPct}%` : ''}</span>`;
  };

  const windCell = d => {
    const w = d.wind || {};
    if (!isNum(w.index)) return '<span class="mk-big">—</span>';
    return `<span class="mk-big">${w.index}%</span> ${deltaChip(d.deltas && d.deltas.wind)}${bar('wind', w.index)}`
      + `<span class="mk-sub">${isNum(w.meanKmh) ? `⌀ ${Math.round(w.meanKmh)}` : ''}${isNum(w.gustMax) ? ` · gust ${w.gustMax} km/h` : ''}</span>`;
  };

  const riskCell = d => {
    const risks = (d.risks || []).slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    if (!risks.length) return '<span class="risk-none">— none</span>';
    return `<div class="risks">${risks.map(riskChip).join('')}</div>`;
  };

  const residualCell = d => {
    if (d.context) return '<span class="risk-none">context</span>';
    return verdictBadge(d.residual) + driverChips(d.residual);
  };

  return `<div class="table-scroll"><table class="box">
      <thead><tr><th class="row-label">Fundamentals</th>${head}</tr></thead>
      <tbody>
        ${row('⛅ Weather', TIPS.weather, 'Weather', weatherCell)}
        ${row('🌡️ Demand temp', TIPS.demand, 'Demand', demandCell)}
        ${row('☀️ Solar', TIPS.solar, 'Solar generation', solarCell)}
        ${row('💨 Wind', TIPS.wind, 'Wind generation', windCell)}
        ${row('⚠️ Risks', TIPS.risks, 'Risks', riskCell)}
        ${row('🧭 Residual load', TIPS.residual, 'Residual load', residualCell)}
      </tbody></table></div>`;
}

function card(brief) {
  const flag = pick(FLAGS, brief.country);
  const h = brief.headline || {};
  const day = (brief.days || []).find(d => d.label === h.day);
  const when = day ? `${h.day} · ${weekdayName(day.date, true)} ${shortDate(day.date)}` : (h.day || '');
  const cities = (brief.cities || []).map(c => `${c.name} ${c.weight}`).join(' · ');

  return `<div class="mk-card">
      <div class="mk-head"><h2>${flag} ${esc(brief.name)}</h2><span class="mk-when">${esc(when)}</span></div>
      <div class="mk-cities"${tipAttr('Every country number is a population-weighted average of these cities (weights in millions, rough).', 'Weighting')}>Weighted: ${esc(cities)}</div>
      ${tiles(brief)}
      ${stabilityStrip(brief.stability)}
      ${dayTable(brief)}
    </div>`;
}

export async function loadMarket(source) {
  const grid = el('marketGrid');
  if (!grid.innerHTML.trim()) grid.innerHTML = '<div class="loading">Loading the market brief…</div>';
  try {
    // ONE request for the whole tab. v2.0 made five.
    const data = await getJson(`/api/market?source=${encodeURIComponent(source)}`, { ttlMs: 5 * 60 * 1000 });
    const cards = (data.countries || []).map(card);
    if (!cards.length) {
      grid.innerHTML = '<div class="error">Could not load the market brief.</div>';
      el('marketFooter').innerHTML = '';
      return;
    }
    grid.innerHTML = cards.join('');
    el('marketFooter').innerHTML =
      `Weather fundamentals from Open-Meteo. Not a price forecast and not trading advice. `
      + `Generated ${esc(localTime(data.generatedAt))}.`;
  } catch (e) {
    console.error('Market load failed:', e);
    grid.innerHTML = '<div class="error">Could not load the market brief.</div>';
  }
}
