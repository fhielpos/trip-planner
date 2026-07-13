/* =============================================
   Itinerary Page — printable boarding passes
   One card per transport leg (flight or train), shaped like a real
   boarding pass: a main stub with the route and a torn-off ticket stub,
   meant to be printed or saved as a PDF before departure. Standalone like
   accommodations.js/journey.js — doesn't load app.js/map.js.
   ============================================= */

// ── Theme (duplicated from app.js:5-16 — this page doesn't load app.js) ──
(function () {
  const saved = localStorage.getItem('theme') ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();
document.getElementById('theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'dark' : 'light');
  localStorage.setItem('theme', isLight ? 'dark' : 'light');
});

document.getElementById('btn-print').addEventListener('click', () => window.print());

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtDateLong(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(getDateLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
}

// Purely decorative — evokes a barcode without pretending to encode anything.
function _fakeBarcode(seed) {
  let bars = '';
  let n = seed;
  for (let i = 0; i < 24; i++) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const w = 1 + (n % 3);
    bars += `<span style="width:${w}px"></span>`;
  }
  return bars;
}

function _boardingPassHtml(leg, index, total) {
  const isFlight = leg.mode === 'flight';
  const eyebrow = t(isFlight ? 'itinerary.boardingPass' : 'itinerary.trainTicket');
  const icon = isFlight ? '✈️' : '🚆';
  const field1Label = t(isFlight ? 'itinerary.flight' : 'itinerary.notes');
  const field1Val = isFlight ? leg.flightNumber : (leg.notes || '—');

  return `
    <div class="bp" style="--bp-accent: var(--c-${leg.mode})">
      <div class="bp-main">
        <div class="bp-eyebrow">
          <span>${eyebrow}</span>
          <span class="bp-seq accom-mono">${String(index + 1).padStart(2, '0')}/${total}</span>
        </div>
        <div class="bp-route">
          <div class="bp-route-side">
            <span class="bp-city">${_escHtml(leg.fromCity)}</span>
            ${leg.fromCode ? `<span class="bp-code accom-mono">${leg.fromCode}</span>` : ''}
          </div>
          <span class="bp-route-icon">${icon}</span>
          <div class="bp-route-side bp-route-side--right">
            <span class="bp-city">${_escHtml(leg.toCity)}</span>
            ${leg.toCode ? `<span class="bp-code accom-mono">${leg.toCode}</span>` : ''}
          </div>
        </div>
        <div class="bp-fields">
          <div class="bp-field"><span class="bp-field-label">${field1Label}</span><span class="bp-field-val accom-mono">${_escHtml(String(field1Val))}</span></div>
          <div class="bp-field"><span class="bp-field-label">${t('journey.col.date')}</span><span class="bp-field-val accom-mono">${_fmtDateLong(leg.date)}</span></div>
          <div class="bp-field"><span class="bp-field-label">${t('itinerary.departs')}</span><span class="bp-field-val accom-mono">${leg.departureTime || '—'}</span></div>
          <div class="bp-field"><span class="bp-field-label">${t('itinerary.arrives')}</span><span class="bp-field-val accom-mono">${leg.arrivalTime || '—'}</span></div>
        </div>
      </div>
      <div class="bp-stub">
        <span class="bp-stub-route accom-mono">${leg.fromCode ? leg.fromCode : _escHtml(leg.fromCity)} → ${leg.toCode ? leg.toCode : _escHtml(leg.toCity)}</span>
        <span class="bp-stub-date accom-mono">${fmtDate(leg.date, { year: false })}</span>
        <span class="bp-stub-icon">${icon}</span>
        <div class="bp-barcode">${_fakeBarcode(index + 1)}</div>
      </div>
    </div>`;
}

document.addEventListener('langchange', () => { if (_lastLegs) _render(_lastLegs); });

let _lastLegs = null;

function _render(legs) {
  document.getElementById('itinerary-list').innerHTML =
    legs.map((leg, i) => _boardingPassHtml(leg, i, legs.length)).join('');
}

async function _init() {
  await initI18n();
  const tripRes = await fetch('/api/trip');
  const trip = await tripRes.json();

  const flightLegs = (trip.flights || []).map(f => ({
    mode: 'flight',
    fromCity: f.fromCity, toCity: f.toCity,
    fromCode: f.from, toCode: f.to,
    date: f.departureDate,
    departureTime: f.departureTime, arrivalTime: f.arrivalTime,
    flightNumber: f.flightNumber,
  }));
  const trainLegs = (trip.trains || []).map(tr => ({
    mode: 'train',
    fromCity: tr.fromCity, toCity: tr.toCity,
    fromCode: null, toCode: null,
    date: tr.departureDate,
    departureTime: tr.departureTime, arrivalTime: tr.arrivalTime,
    notes: tr.notes,
  }));
  const legs = [...flightLegs, ...trainLegs].sort((a, b) => a.date.localeCompare(b.date));

  _lastLegs = legs;
  _render(legs);
}

_init();
