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
  _populateCurrencyDropdown(status.currency.currencyCodes);
  _renderOverrides(status.currency.overrideRules);

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

function _populateCurrencyDropdown(codes) {
  const select = document.getElementById('admin-override-currency');
  const current = select.value;
  select.innerHTML = `<option value="" disabled${current ? '' : ' selected'}>Choose</option>` +
    (codes || []).map(c => `<option value="${c}"${c === current ? ' selected' : ''}>${c}</option>`).join('');
}

function _renderOverrides(rules) {
  const el = document.getElementById('admin-override-list');
  const entries = Object.entries(rules || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    el.innerHTML = '<p class="admin-note">No overrides configured.</p>';
    return;
  }
  el.innerHTML = entries.map(([currency, rule]) => `
    <div class="admin-override-row" data-currency="${currency}">
      <label class="admin-override-toggle">
        <input type="checkbox" class="admin-override-enabled" ${rule.enabled ? 'checked' : ''} />
        ${currency}
      </label>
      <span class="admin-override-rate">${rule.rate} → USD</span>
      <button type="button" class="subbudget-remove admin-override-delete" aria-label="Delete override">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`).join('');
}

document.getElementById('admin-override-list').addEventListener('change', async e => {
  const checkbox = e.target.closest('.admin-override-enabled');
  if (!checkbox) return;
  const currency = checkbox.closest('.admin-override-row').dataset.currency;
  await fetch(`/api/rates/override-rules/${currency}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checkbox.checked }),
  });
  await _loadStatus();
});

document.getElementById('admin-override-list').addEventListener('click', async e => {
  const btn = e.target.closest('.admin-override-delete');
  if (!btn) return;
  const currency = btn.closest('.admin-override-row').dataset.currency;
  await fetch(`/api/rates/override-rules/${currency}`, { method: 'DELETE' });
  await _loadStatus();
});

document.getElementById('admin-override-add-btn').addEventListener('click', async () => {
  const currencySelect = document.getElementById('admin-override-currency');
  const rateInput = document.getElementById('admin-override-rate');
  const currency = currencySelect.value;
  const rate = parseFloat(rateInput.value);
  if (!currency || !Number.isFinite(rate) || rate <= 0) return;
  await fetch(`/api/rates/override-rules/${currency}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate, enabled: true }),
  });
  currencySelect.value = '';
  rateInput.value = '';
  await _loadStatus();
});

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
