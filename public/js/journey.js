/* =============================================
   Journey Page — "La ruta" (redesign 4b)

   The whole itinerary as one chronological spine: stays and legs
   (flights + trains) alternating on a single rail, accommodation nested
   inside each stay, missing data shown as missing, gaps/overlaps flagged
   inline. Standalone like accommodations.js — does NOT load app.js/map.js,
   so a few small helpers are duplicated here rather than reaching into
   those files' DOM-coupled globals.
   ============================================= */

// ── Theme (duplicated from app.js:5-16 — this page doesn't load app.js) ──
(function () {
  let raw = localStorage.getItem('theme');
  if (raw === 'light') raw = 'terracotta';
  if (!['carbon', 'terracotta', 'system'].includes(raw)) raw = 'carbon';
  const resolved = raw === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'terracotta' : 'carbon')
    : raw;
  document.documentElement.setAttribute('data-theme', resolved);
})();
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'terracotta' ? 'carbon' : 'terracotta';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

// ── Small helpers (duplicated from app.js — not loaded here) ──
function _parseLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function _fmtTime24(str) {
  if (!str) return '';
  const [h, m] = str.split(':');
  return `${String(Number(h)).padStart(2, '0')}:${String(Number(m || 0)).padStart(2, '0')}`;
}
function _nights(inISO, outISO) {
  return Math.round((_parseLocal(outISO) - _parseLocal(inISO)) / 86400000);
}
function _daysInclusive(startISO, endISO) {
  return Math.round((_parseLocal(endISO) - _parseLocal(startISO)) / 86400000) + 1;
}
// Dev override: ?today=YYYY-MM-DD previews any trip day (app.js:141-150).
function _today() {
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (k.toLowerCase() === 'today' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const COUNTRY_FLAG_CODES = {
  Argentina: 'AR', Brazil: 'BR', France: 'FR', Greece: 'GR', Austria: 'AT',
  Germany: 'DE', Switzerland: 'CH', Netherlands: 'NL', Belgium: 'BE',
  Spain: 'ES', Italy: 'IT', Portugal: 'PT', 'United Kingdom': 'GB', 'United States': 'US',
};
function _flag(country) {
  const cc = COUNTRY_FLAG_CODES[country];
  if (!cc) return '';
  return String.fromCodePoint(...[...cc].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function _escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtD(iso) {
  return fmtDate(iso, { year: false });
}

// ── Issue detection — pairs of stays sharing a night, and nights nobody
//    booked. Mirrors computeStayIssues() in timeline.js (not loaded here).
function _stayIssues(list, rangeStart, rangeEnd) {
  const sorted = [...list].sort((a, b) => a.check_in.localeCompare(b.check_in));
  const overlaps = [];
  const gaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const start = a.check_in > b.check_in ? a.check_in : b.check_in;
      const end = a.check_out < b.check_out ? a.check_out : b.check_out;
      if (start < end) overlaps.push({ a, b, start, end });
    }
  }
  let cursor = rangeStart;
  for (const s of sorted) {
    if (s.check_in > cursor) gaps.push({ start: cursor, end: s.check_in });
    if (s.check_out > cursor) cursor = s.check_out;
  }
  if (cursor < rangeEnd) gaps.push({ start: cursor, end: rangeEnd });
  return { overlaps, gaps };
}

// A stay counts as "booked" once it carries any reservation detail.
function _hasBooking(s) {
  return !!(s.address || s.total_price != null || s.url || s.name);
}

// ── Merge flights + trains into one chronological leg list, the way
//    _nextLeg() in today.js does (that file isn't loaded here).
function _buildLegs(flights, trains) {
  const legs = [
    ...flights.map(f => ({
      mode: 'flight',
      date: f.departureDate,
      time: f.departureTime || '',
      arrivalDate: f.arrivalDate || f.departureDate,
      fromCode: f.from, toCode: f.to,
      fromCity: f.fromCity, toCity: f.toCity,
      carrier: f.flightNumber || '',
    })),
    ...trains.map(tr => ({
      mode: 'train',
      date: tr.departureDate,
      time: tr.departureTime || '',
      arrivalDate: tr.arrivalDate || tr.departureDate,
      fromCode: tr.fromCity, toCode: tr.toCity,
      fromCity: tr.fromCity, toCity: tr.toCity,
      carrier: tr.operator || '',
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  legs.forEach((l, i) => { l.seq = i + 1; });
  return legs;
}

// ── Render pieces ──────────────────────────────────────────────────────

function _railHtml(nodeHtml) {
  return `<div class="journey-rail">
    <div class="journey-rail-stub"></div>
    ${nodeHtml}
    <div class="journey-rail-line"></div>
  </div>`;
}

function _legRow(leg, today) {
  const future = leg.date > today;
  const rowCls = future ? 'journey-row--future' : 'journey-row--past';
  const glyph = leg.mode === 'flight' ? '✈' : '⇢';
  const route = leg.mode === 'flight'
    ? `${_escHtml(leg.fromCode)} → ${_escHtml(leg.toCode)}`
    : `${_escHtml(leg.fromCity)} → ${_escHtml(leg.toCity)}`;

  let detail;
  if (leg.mode === 'flight') {
    detail = (leg.carrier || leg.time)
      ? `${_fmtD(leg.date)} · ${_escHtml(leg.carrier || t('journey.leg.noFlightData'))}${leg.time ? ' · ' + _fmtTime24(leg.time) : ''}`
      : `${_fmtD(leg.date)} · ${t('journey.leg.noFlightData')}`;
  } else {
    detail = `${_fmtD(leg.date)} · ${t('journey.leg.train')} · ${leg.time ? _fmtTime24(leg.time) : t('journey.leg.noTime')}`;
  }

  const node = `<div class="journey-node journey-node--leg journey-node--${leg.mode}">${glyph}</div>`;
  return `<div class="journey-row ${rowCls}" data-kind="leg" data-mode="${leg.mode}">
    ${_railHtml(node)}
    <div class="journey-content">
      <div class="journey-leg journey-leg--${leg.mode}">
        <span class="label mono journey-leg-seq">${leg.seq}/${leg.total}</span>
        <div class="journey-leg-body">
          <div class="mono journey-leg-route">${route}</div>
          <div class="mono journey-leg-detail">${detail}</div>
        </div>
      </div>
    </div>
  </div>`;
}

function _stayRow(stay, today) {
  const phase = (() => {
    if (stay.check_out <= today) return 'past';
    if (stay.check_in > today) return 'future';
    return 'current';
  })();
  const rowCls = `journey-row--${phase}`;
  const nights = _nights(stay.check_in, stay.check_out);
  const booked = _hasBooking(stay);

  const nodeCls = phase === 'current' ? 'journey-node--current' : 'journey-node--stay';
  const node = `<div class="journey-node ${nodeCls}"></div>`;

  const hereChip = phase === 'current'
    ? `<span class="label journey-stay-here">${t('journey.stay.here')}</span>` : '';

  let bodyMain, bodyEnd;
  if (booked) {
    const name = stay.name || (stay.address ? String(stay.address).split(',')[0].trim() : stay.city);
    let sub;
    if (phase === 'current') {
      const n = _nights(stay.check_in, today) + 1;
      sub = t('journey.stay.current', { n, total: nights, date: _fmtD(stay.check_out) });
    } else if (stay.check_in_time || stay.check_out_time) {
      sub = t('journey.stay.times', {
        in: stay.check_in_time || '—', out: stay.check_out_time || '—',
      });
    } else {
      sub = t('journey.stay.booked');
    }
    bodyMain = `<div class="journey-stay-name">${_escHtml(name)}</div>
      <div class="mono journey-stay-sub">${_escHtml(sub)}</div>`;
    bodyEnd = `<span class="journey-stay-chev">›</span>`;
  } else {
    bodyMain = `<div class="journey-stay-name journey-stay-name--empty">${t('journey.stay.noAccom')}</div>
      <div class="mono journey-stay-sub">${t('journey.stay.nightsUnbooked', { n: nights })}</div>`;
    bodyEnd = `<button type="button" class="label journey-stay-add">${t('journey.stay.add')} ›</button>`;
  }

  return `<div class="journey-row ${rowCls}" data-kind="stay" data-booked="${booked ? 1 : 0}">
    ${_railHtml(node)}
    <div class="journey-content">
      <div class="journey-stay">
        <div class="journey-stay-head">
          <span class="journey-stay-flag">${_flag(stay.country)}</span>
          <span class="label journey-stay-city">${_escHtml(stay.city)}</span>
          <span class="mono journey-stay-dates">${_fmtD(stay.check_in)} – ${_fmtD(stay.check_out)} · ${nights} n</span>
          ${hereChip}
        </div>
        <div class="journey-stay-body">
          <div class="journey-stay-main">${bodyMain}</div>
          ${bodyEnd}
        </div>
      </div>
    </div>
  </div>`;
}

function _issueRow(issue, today) {
  const future = issue.start > today;
  const rowCls = future ? 'journey-row--future' : 'journey-row--past';
  const node = `<div class="journey-node journey-node--issue">!</div>`;
  let text;
  if (issue.type === 'overlap') {
    const range = `${_fmtD(issue.start)} – ${_fmtD(issue.end)}`;
    text = issue.a.city === issue.b.city
      ? t('journey.issue.overlapSame', { city: issue.a.city, range })
      : t('journey.issue.overlap', { a: issue.a.city, b: issue.b.city, range });
  } else {
    text = t('journey.issue.gap', {
      range: `${_fmtD(issue.start)} – ${_fmtD(issue.end)}`,
      n: _nights(issue.start, issue.end),
    });
  }
  return `<div class="journey-row ${rowCls}" data-kind="issue">
    ${_railHtml(node)}
    <div class="journey-content">
      <div class="journey-issue">
        <span class="journey-issue-text">${_escHtml(text)}</span>
        <button type="button" class="label journey-issue-action" data-action="resolve">${t('journey.issue.resolve')} ›</button>
      </div>
    </div>
  </div>`;
}

function _bookendRow(kind, city, country, metaText, today, dateISO) {
  const future = dateISO > today;
  const rowCls = future ? 'journey-row--future' : 'journey-row--past';
  const firstLast = kind === 'depart' ? 'is-first' : 'is-last';
  const node = `<div class="journey-node journey-node--bookend"></div>`;
  return `<div class="journey-row ${rowCls} ${firstLast}" data-kind="bookend">
    ${_railHtml(node)}
    <div class="journey-content">
      <div class="journey-bookend-head">
        <span class="journey-bookend-flag">${_flag(country)}</span>
        <span class="label journey-bookend-city">${_escHtml(city)}</span>
        <span class="mono journey-bookend-meta" style="margin-left:auto">${_escHtml(metaText)}</span>
      </div>
    </div>
  </div>`;
}

// ── State + orchestration ─────────────────────────────────────────────

let _model = null;      // { stays, legs, issues, tripMeta, today }
let _filter = 'all';

function _renderSummary() {
  const { stays, legs, tripMeta } = _model;
  const start = tripMeta.startDate || stays[0].check_in;
  const end = tripMeta.endDate || stays[stays.length - 1].check_out;
  const days = _daysInclusive(start, end);
  document.getElementById('journey-summary').textContent =
    t('journey.summary', { stays: stays.length, legs: legs.length, days });
}

function _renderBanner() {
  const { stays, issues } = _model;
  const el = document.getElementById('journey-banner');
  const missing = stays.filter(s => !_hasBooking(s));
  const problems = missing.length + issues.overlaps.length + issues.gaps.length;

  const conflicts = issues.overlaps.length + issues.gaps.length;
  el.hidden = false;
  el.classList.toggle('journey-banner--ok', problems === 0);
  const glyph = problems === 0 ? '✓' : '!';
  let text;
  if (missing.length) text = t('journey.banner.missing', { n: missing.length, total: stays.length });
  else if (conflicts) text = t('journey.banner.conflicts', { n: conflicts, total: stays.length });
  else text = t('journey.banner.complete', { total: stays.length });
  const action = problems === 0 ? '' :
    `<button type="button" class="label journey-banner-action" data-action="review">${t('journey.banner.review')} ›</button>`;
  el.innerHTML = `<span class="journey-banner-glyph">${glyph}</span>
    <span class="journey-banner-text">${_escHtml(text)}</span>${action}`;
}

// Build the merged, chronological list of spine items. Legs sort before
// stays on a shared date (you leave a city, then check in), legs by time.
function _spineItems() {
  const { stays, legs, issues } = _model;
  const items = [
    ...stays.map(s => ({ kind: 'stay', date: s.check_in, ord: 1, time: '', stay: s })),
    ...legs.map(l => ({ kind: 'leg', date: l.date, ord: 0, time: l.time, leg: l })),
  ].sort((a, b) =>
    a.date.localeCompare(b.date) || a.ord - b.ord ||
    (a.time || '99:99').localeCompare(b.time || '99:99'));

  // Attach each overlap issue just before the later stay of the pair.
  const out = [];
  const seenIssue = new Set();
  for (const it of items) {
    if (it.kind === 'stay') {
      issues.overlaps.forEach((ov, i) => {
        if (ov.b === it.stay && !seenIssue.has(i)) {
          seenIssue.add(i);
          out.push({ kind: 'issue', date: ov.start, issue: { type: 'overlap', ...ov } });
        }
      });
    }
    out.push(it);
  }
  // Gaps: place at the gap start.
  issues.gaps.forEach(g => out.push({ kind: 'issue', date: g.start, issue: { type: 'gap', ...g } }));
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function _matchesFilter(it) {
  if (_filter === 'all') return true;
  if (_filter === 'incomplete') {
    if (it.kind === 'issue') return true;
    if (it.kind === 'stay') return !_hasBooking(it.stay);
    return false;
  }
  if (_filter === 'stay') return it.kind === 'stay' || it.kind === 'issue';
  if (_filter === 'flight') return (it.kind === 'leg' && it.leg.mode === 'flight');
  if (_filter === 'train') return (it.kind === 'leg' && it.leg.mode === 'train');
  return true;
}

function _renderSpine() {
  const { legs, stays, tripMeta, today } = _model;
  const el = document.getElementById('journey-spine');
  const items = _spineItems().filter(_matchesFilter);

  const parts = [];

  // Departure bookend — origin of the first leg.
  if (_filter === 'all' && legs.length) {
    const l0 = legs[0];
    const meta = l0.time
      ? t('journey.bookend.depart', { date: _fmtD(l0.date), time: _fmtTime24(l0.time), code: l0.fromCode })
      : t('journey.bookend.departNoTime', { date: _fmtD(l0.date), code: l0.fromCode });
    parts.push(_bookendRow('depart', l0.fromCity, stays[0] && stays[0].country, meta, today, l0.date));
  }

  for (const it of items) {
    if (it.kind === 'leg') parts.push(_legRow({ ...it.leg, total: legs.length }, today));
    else if (it.kind === 'stay') parts.push(_stayRow(it.stay, today));
    else if (it.kind === 'issue') parts.push(_issueRow(it.issue, today));
  }

  // Arrival bookend — destination of the last leg.
  if (_filter === 'all' && legs.length) {
    const lN = legs[legs.length - 1];
    const meta = t('journey.bookend.arrive', { date: _fmtD(lN.arrivalDate || lN.date) });
    parts.push(_bookendRow('arrive', lN.toCity, stays[stays.length - 1] && stays[stays.length - 1].country, meta, today, lN.arrivalDate || lN.date));
  }

  el.innerHTML = parts.join('') ||
    `<p class="journey-empty">${t('journey.empty')}</p>`;

  // First/last visible row lose their dangling connector stubs.
  const rows = el.querySelectorAll('.journey-row');
  if (rows.length) {
    rows[0].classList.add('is-first');
    rows[rows.length - 1].classList.add('is-last');
  }
}

function _renderAll() {
  _renderSummary();
  _renderBanner();
  _renderSpine();
}

function _goToday() {
  const el = document.getElementById('journey-spine');
  const target = el.querySelector('.journey-row--current') || el.querySelector('.journey-row--future');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _setFilter(f) {
  _filter = f;
  document.querySelectorAll('.journey-chip').forEach(c =>
    c.classList.toggle('is-active', c.dataset.filter === f));
  _renderSpine();
}

function _wireControls() {
  document.getElementById('journey-today-btn')?.addEventListener('click', _goToday);
  document.getElementById('journey-filters')?.addEventListener('click', e => {
    const chip = e.target.closest('.journey-chip');
    if (chip) _setFilter(chip.dataset.filter);
  });
  document.getElementById('journey-banner')?.addEventListener('click', e => {
    if (e.target.closest('[data-action="review"]')) _setFilter('incomplete');
  });
  document.getElementById('journey-spine')?.addEventListener('click', e => {
    if (e.target.closest('[data-action="resolve"]')) _setFilter('incomplete');
  });
  const back = document.querySelector('.journey-back');
  if (back) back.setAttribute('aria-label', t('accom.back'));
}

document.addEventListener('langchange', () => { if (_model) { _wireControls(); _renderAll(); } });

async function _init() {
  await initI18n();

  const [tripRes, accomRes, flightsRes] = await Promise.all([
    fetch('/api/trip'),
    fetch('/api/accommodations'),
    fetch('/api/flights'),
  ]);
  const trip = await tripRes.json();
  const accommodations = await accomRes.json();
  const flights = await flightsRes.json();

  const tripMeta = trip.trip || {};
  const trains = trip.trains || [];
  const today = _today();

  const stays = [...accommodations]
    .filter(s => s.check_in && s.check_out)
    .sort((a, b) => a.check_in.localeCompare(b.check_in));
  const legs = _buildLegs(flights, trains);

  const rangeStart = [tripMeta.startDate, stays[0] && stays[0].check_in]
    .filter(Boolean).sort()[0];
  const rangeEnd = [tripMeta.endDate, stays.length && stays[stays.length - 1].check_out]
    .filter(Boolean).sort().pop();
  const issues = _stayIssues(stays, rangeStart, rangeEnd);

  _model = { stays, legs, issues, tripMeta, today };
  _wireControls();
  _renderAll();
}

_init();
