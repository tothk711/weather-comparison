// ---------------------------------------------------------------------------
// The hover layer.
//
// v2.0 used the browser's native `title` attribute everywhere: small system
// type, no styling, no wrapping control, and roughly half a second of delay
// before anything appeared. This module replaces all of it with one floating
// element driven by `data-tip` (and optional `data-tip-title`), delegated from
// document so it works on markup that is re-rendered constantly.
//
// Timing, all deliberately at least twice as fast as what it replaces:
//   SHOW_DELAY  120 ms  (native title tooltips: ~500 ms)
//   FADE        110 ms  (--tip-fade)
//   MOVE_DELAY   45 ms  (moving between two tipped elements feels instant)
// ---------------------------------------------------------------------------

export const SHOW_DELAY_MS = 120;
const MOVE_DELAY_MS = 45;
const HIDE_DELAY_MS = 60;
const GAP = 11;

let tip = null;
let arrow = null;
let showTimer = null;
let hideTimer = null;
let current = null;
let wasVisible = false;

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'ztip';
  tip.setAttribute('role', 'tooltip');
  tip.innerHTML = '<span class="tip-arrow"></span><span class="tip-title"></span><span class="tip-body"></span>';
  document.body.appendChild(tip);
  arrow = tip.querySelector('.tip-arrow');
  return tip;
}

function place(target) {
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;

  // Prefer below; flip above when there is no room.
  let below = r.bottom + GAP + t.height <= vh - 8;
  if (!below && r.top - GAP - t.height < 8) below = true; // neither fits: stay below
  const top = below ? r.bottom + GAP : r.top - GAP - t.height;

  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, vw - t.width - 8));

  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.classList.toggle('below', below);
  tip.classList.toggle('above', !below);

  // Point the arrow at the element's centre, clamped inside the bubble.
  const centre = r.left + r.width / 2;
  const ax = Math.max(14, Math.min(centre - left - 5, t.width - 24));
  arrow.style.left = `${Math.round(ax)}px`;
}

function render(target) {
  ensure();
  const body = target.getAttribute('data-tip') || '';
  const title = target.getAttribute('data-tip-title') || '';
  const titleEl = tip.querySelector('.tip-title');
  const bodyEl = tip.querySelector('.tip-body');
  // textContent, NOT innerHTML.
  //
  // An earlier draft rendered the body as HTML "because the app authors every
  // tip". That was not true: the Market tab builds tips from risk detail and
  // residual-load summary strings that arrive in the /api/market payload. With
  // innerHTML that is a live injection path — the attribute round trip decodes
  // any entity right back into markup. Plain text closes it, and no tip in the
  // app needs markup.
  titleEl.textContent = title;
  titleEl.style.display = title ? '' : 'none';
  bodyEl.textContent = body;
  tip.style.maxWidth = target.getAttribute('data-tip-wide') ? '460px' : '';
  current = target;
  place(target);
  tip.classList.add('show');
  wasVisible = true;
}

function hide() {
  clearTimeout(showTimer);
  if (!tip) return;
  tip.classList.remove('show');
  current = null;
  hideTimer = setTimeout(() => { wasVisible = false; }, 220);
}

function onEnter(e) {
  const target = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!target || target === current) return;
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  // Sliding from one tipped element to the next should not re-pay the delay.
  const delay = wasVisible ? MOVE_DELAY_MS : SHOW_DELAY_MS;
  showTimer = setTimeout(() => render(target), delay);
}

function onLeave(e) {
  const target = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!target) return;
  const to = e.relatedTarget;
  if (to && to.closest && to.closest('[data-tip]') === target) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(hide, HIDE_DELAY_MS);
}

export function initTooltips() {
  ensure();
  document.addEventListener('mouseover', onEnter, true);
  document.addEventListener('mouseout', onLeave, true);
  document.addEventListener('focusin', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) { clearTimeout(showTimer); render(t); }
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  // A tooltip anchored to something that scrolled away is worse than none.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('[data-tip]')) hide();
  }, true);
}

// Attribute helper for generated markup: tipAttr(text, title) -> ` data-tip="…"`.
// Escapes every character that can end an attribute or open a tag, so it is
// safe for API-derived strings (Market risk details, residual-load summaries)
// as well as for the hard-coded TIPS constants.
function escAttr(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function tipAttr(body, title) {
  if (!body) return '';
  return ` data-tip="${escAttr(body)}"${title ? ` data-tip-title="${escAttr(title)}"` : ''}`;
}
