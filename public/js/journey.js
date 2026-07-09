/* =============================================
   Journey Page — the movement side of the trip
   (Accommodations Insights covers the stays/cost side; this page covers
   legs/distance/countries.) Standalone like accommodations.js: doesn't
   load app.js/map.js, so small bits are duplicated rather than reaching
   into those files' DOM-coupled globals.
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

const COUNTRY_FLAG_CODES = {
  Argentina: 'AR', Brazil: 'BR', France: 'FR', Greece: 'GR', Austria: 'AT',
  Germany: 'DE', Switzerland: 'CH', Netherlands: 'NL', Belgium: 'BE',
  Spain: 'ES', Italy: 'IT', Portugal: 'PT', 'United Kingdom': 'GB', 'United States': 'US',
};
function _countryFlag(country) {
  const cc = COUNTRY_FLAG_CODES[country];
  if (!cc) return '';
  return String.fromCodePoint(...[...cc].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Great-circle distance between two lat/lon points, in km.
function _haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _fmtKm(km) {
  return Math.round(km).toLocaleString(getDateLocale()) + ' km';
}

function _renderStats(legs, countries) {
  const el = document.getElementById('journey-stats-grid');
  const totalKm = legs.reduce((s, l) => s + (l.km || 0), 0);
  const flightCount = legs.filter(l => l.mode === 'flight').length;
  const trainCount = legs.filter(l => l.mode === 'train').length;

  const item = (label, val) => `
    <div class="accom-manifest-item">
      <span class="accom-manifest-label">${label}</span>
      <span class="accom-manifest-val accom-mono">${val}</span>
    </div>`;

  el.innerHTML = [
    item(t('journey.stats.countries'), countries.length),
    item(t('journey.stats.distance'), _fmtKm(totalKm)),
    item(t('journey.stats.flights'), flightCount),
    item(t('journey.stats.trains'), trainCount),
  ].join('');
}

// One chip per country, in first-visited order, showing nights spent there —
// reuses the flag glyph already established in the Today view hero.
function _renderCountries(countries) {
  const el = document.getElementById('journey-countries');
  el.innerHTML = countries.map(c => `
    <div class="journey-country-chip">
      <span class="journey-country-flag">${_countryFlag(c.name)}</span>
      <span class="journey-country-name">${_escHtml(c.name)}</span>
      <span class="journey-country-nights accom-mono">${c.nights}n</span>
    </div>`).join('');
}

// Chronological log of every transport leg, styled as manifest rows like
// the accommodations page — a colored spine (reusing --c-flight/--c-train,
// the same tokens as the day-card chips and map pins) instead of a new hue.
function _renderList(legs) {
  const el = document.getElementById('journey-list');
  el.innerHTML = legs.map((l, i) => `
    <div class="journey-row" style="--leg-color:var(--c-${l.mode})">
      <div class="journey-row-main">
        <span class="journey-row-index accom-mono">${String(i + 1).padStart(2, '0')}⁄${legs.length}</span>
        <span class="journey-row-icon">${l.mode === 'flight' ? '✈️' : '🚆'}</span>
        <span class="journey-row-route">${_escHtml(l.fromCity)} → ${_escHtml(l.toCity)}</span>
      </div>
      <div class="journey-row-figure">
        <span class="journey-row-figure-label">${t('journey.col.date')}</span>
        <span class="journey-row-figure-val accom-mono">${fmtDate(l.date, { year: false })}</span>
      </div>
      <div class="journey-row-figure">
        <span class="journey-row-figure-label">${t('journey.col.distance')}</span>
        <span class="journey-row-figure-val accom-mono">${l.km != null ? _fmtKm(l.km) : '—'}</span>
      </div>
    </div>`).join('');
}

document.addEventListener('langchange', () => { if (_lastLegs) { _renderStats(_lastLegs, _lastCountries); _renderCountries(_lastCountries); _renderList(_lastLegs); } });

let _lastLegs = null;
let _lastCountries = null;

async function _init() {
  await initI18n();

  const [tripRes, accomRes, airportsRes] = await Promise.all([
    fetch('/api/trip'),
    fetch('/api/accommodations'),
    fetch('/api/airports').catch(() => null),
  ]);
  const trip = await tripRes.json();
  const accommodations = await accomRes.json();
  const airports = airportsRes && airportsRes.ok ? await airportsRes.json() : {};

  const flightLegs = (trip.flights || []).map(f => {
    const from = airports[f.from], to = airports[f.to];
    return {
      mode: 'flight',
      fromCity: f.fromCity, toCity: f.toCity,
      date: f.departureDate,
      km: from && to ? _haversineKm(from.lat, from.lon, to.lat, to.lon) : null,
    };
  });
  const trainLegs = (trip.trains || []).map(tr => ({
    mode: 'train',
    fromCity: tr.fromCity, toCity: tr.toCity,
    date: tr.departureDate,
    km: (tr.fromLat != null && tr.toLat != null) ? _haversineKm(tr.fromLat, tr.fromLon, tr.toLat, tr.toLon) : null,
  }));
  const legs = [...flightLegs, ...trainLegs].sort((a, b) => a.date.localeCompare(b.date));

  // Countries in first-visited order, with total nights spent in each.
  const sortedStays = [...accommodations].sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''));
  const nightsFor = s => Math.round((new Date(s.check_out) - new Date(s.check_in)) / 86400000);
  const countryMap = new Map();
  for (const s of sortedStays) {
    if (!s.country) continue;
    if (!countryMap.has(s.country)) countryMap.set(s.country, 0);
    countryMap.set(s.country, countryMap.get(s.country) + nightsFor(s));
  }
  const countries = [...countryMap.entries()].map(([name, nights]) => ({ name, nights }));

  _lastLegs = legs;
  _lastCountries = countries;
  _renderStats(legs, countries);
  _renderCountries(countries);
  _renderList(legs);
}

_init();
