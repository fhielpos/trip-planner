/* =============================================
   Admin status page — hidden operator view, reachable only via the
   footer commit link. English-only, no i18n.
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

function _formatTimestamp(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

async function _loadStatus() {
  const [status, version] = await Promise.all([
    fetch('/api/admin/status').then(r => r.json()),
    fetch('/api/version').then(r => r.json()),
  ]);

  document.getElementById('admin-commit').textContent = version.commit;

  document.getElementById('admin-weather-updated').textContent = _formatTimestamp(status.weather.lastUpdated);
  document.getElementById('admin-weather-stays').textContent = status.weather.staysTracked;

  document.getElementById('admin-currency-updated').textContent = _formatTimestamp(status.currency.lastUpdated);
  document.getElementById('admin-currency-count').textContent = status.currency.currencyCount;
  document.getElementById('admin-currency-overrides').textContent = status.currency.overrideCount;

  document.getElementById('admin-flights-count').textContent = status.flights.count;
  document.getElementById('admin-flights-synced').textContent = _formatTimestamp(status.flights.lastSyncedAt);

  document.getElementById('admin-airports-count').textContent = status.airports.cachedCount;

  document.getElementById('admin-geocode-accom-total').textContent = status.geocoding.accommodations.total;
  document.getElementById('admin-geocode-accom-ok').textContent = status.geocoding.accommodations.ok;
  document.getElementById('admin-geocode-accom-failed').textContent = status.geocoding.accommodations.failed;
  document.getElementById('admin-geocode-accom-none').textContent = status.geocoding.accommodations.notAttempted;

  document.getElementById('admin-geocode-activity-total').textContent = status.geocoding.activities.total;
  document.getElementById('admin-geocode-activity-ok').textContent = status.geocoding.activities.ok;
  document.getElementById('admin-geocode-activity-failed').textContent = status.geocoding.activities.failed;
  document.getElementById('admin-geocode-activity-none').textContent = status.geocoding.activities.notAttempted;
}

async function _refresh(btn, url) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Refreshing…';
  try {
    await fetch(url, { method: 'POST' });
    await _loadStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

document.getElementById('admin-weather-refresh').addEventListener('click', e => {
  _refresh(e.target, '/api/weather/refresh');
});
document.getElementById('admin-currency-refresh').addEventListener('click', e => {
  _refresh(e.target, '/api/rates/refresh');
});
document.getElementById('admin-geocode-refresh').addEventListener('click', e => {
  _refresh(e.target, '/api/geocode/refresh');
});

_loadStatus();
