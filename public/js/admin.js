/* =============================================
   Admin status page — hidden operator view, reachable only via the
   footer commit link. English-only, no i18n.
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

function _formatTimestamp(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

async function _loadStatus() {
  const [status, version] = await Promise.all([
    fetch('/api/admin/status').then(r => r.json()),
    fetch('/api/version').then(r => r.json()),
  ]);

  const commitLink = document.getElementById('admin-commit');
  if (version.commit && version.commit !== 'unknown') {
    commitLink.textContent = version.commit.slice(0, 7);
    commitLink.href = `https://github.com/fhielpos/trip-planner/commit/${version.commit}`;
  } else {
    commitLink.textContent = 'unknown';
    commitLink.removeAttribute('href');
  }
  document.getElementById('admin-commit-message').textContent = version.commitMessage || '—';

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

  const ai = status.aiSuggestions || { enabled: false };
  const aiSection = document.getElementById('admin-ai-section');
  aiSection.hidden = !ai.enabled;
  if (ai.enabled) {
    document.getElementById('admin-ai-calls').textContent = `${ai.callsLast24h} / ${ai.callLimit}`;
    document.getElementById('admin-ai-cached').textContent = ai.daysCached;
    document.getElementById('admin-ai-locked').textContent = ai.lockedDays;
    document.getElementById('admin-ai-advanced').textContent = ai.advancedUsedDays ?? 0;
  }

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
document.getElementById('admin-ai-reset').addEventListener('click', e => {
  _refresh(e.target, '/api/ai-suggestions/reset-limits');
});
document.getElementById('admin-ai-clear-cache').addEventListener('click', e => {
  _refresh(e.target, '/api/ai-suggestions/clear-cache');
});
document.getElementById('admin-ai-unlock-briefs').addEventListener('click', e => {
  _refresh(e.target, '/api/ai-suggestions/unlock-briefs');
});

_loadStatus();

// ── Import ──────────────────────────────────────────────────────────────
// Server-supplied strings (issue paths/messages, store names, unknown keys,
// error strings) come from a file the user chose and are echoed back — every
// one of them is built with textContent, never innerHTML.

let _importPreviewOk = false;

function _clearNode(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function _appendImportRow(parent, label, value) {
  const row = document.createElement('div');
  row.className = 'admin-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'admin-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'admin-value';
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  parent.appendChild(row);
}

function _appendImportNote(parent, text) {
  const note = document.createElement('p');
  note.className = 'admin-note';
  note.textContent = text;
  parent.appendChild(note);
}

function _importStoreLabel(key) {
  const labels = {
    trip: 'Trip',
    accommodations: 'Accommodations',
    flights: 'Flights',
    documents: 'Documents',
    flighty: 'Flighty text',
  };
  return labels[key] || key;
}

function _importStoreValue(key, value) {
  if (key === 'trip') return `${value.calendar} calendar, ${value.trains} trains`;
  if (key === 'flighty') return `${value} characters`;
  return String(value);
}

function _renderImportIssues(parent, issues, truncated) {
  const list = document.createElement('ul');
  list.className = 'admin-import-issues';
  for (const issue of issues) {
    const li = document.createElement('li');
    li.textContent = `${issue.path || '(root)'} — ${issue.message}`;
    list.appendChild(li);
  }
  if (truncated) {
    const li = document.createElement('li');
    li.textContent = `…and more (showing first ${issues.length})`;
    list.appendChild(li);
  }
  parent.appendChild(list);
}

function _renderImportError(container, body) {
  _clearNode(container);
  _appendImportNote(container, body.error || 'Import failed');
  if (Array.isArray(body.issues)) {
    _renderImportIssues(container, body.issues, body.truncated);
  }
  if (Array.isArray(body.errors)) {
    const list = document.createElement('ul');
    list.className = 'admin-import-issues';
    for (const err of body.errors) {
      const li = document.createElement('li');
      li.textContent = err;
      list.appendChild(li);
    }
    container.appendChild(list);
  }
}

function _renderImportPreview(container, body) {
  _clearNode(container);
  const stores = body.summary.stores || {};
  for (const key of Object.keys(stores)) {
    _appendImportRow(container, _importStoreLabel(key), _importStoreValue(key, stores[key]));
  }
  if (body.summary.skipped.length) {
    _appendImportRow(container, 'Skipped (never imported)', body.summary.skipped.join(', '));
  }
  _appendImportRow(container, 'Documents missing files', body.documentsMissingFiles);
  if (body.willBackUp.length) {
    _appendImportRow(container, 'Files to back up', body.willBackUp.join(', '));
  }
  if (body.cachesToClear.length) {
    _appendImportRow(container, 'Caches to clear', body.cachesToClear.join(', '));
    _appendImportNote(container, 'Clearing the AI-suggestions cache means the next suggestions panel spends an API call.');
  }
  _appendImportNote(container, 'Looks good — click Import to apply these changes.');
}

function _renderImportResult(container, body) {
  _clearNode(container);
  _appendImportRow(container, 'Imported', body.imported.length ? body.imported.join(', ') : 'nothing');
  if (body.skipped.length) {
    _appendImportRow(container, 'Skipped (never imported)', body.skipped.join(', '));
  }
  _appendImportRow(container, 'Documents missing files', body.documentsMissingFiles);
  if (body.cachesCleared.length) {
    _appendImportRow(container, 'Caches cleared', body.cachesCleared.join(', '));
    _appendImportNote(container, 'The AI-suggestions cache was cleared, so the next suggestions panel spends an API call.');
  }
  _appendImportNote(container, `Backup suffix: ${body.backupSuffix}`);
}

const _importFileInput = document.getElementById('admin-import-file');
const _importCheckBtn = document.getElementById('admin-import-check');
const _importRunBtn = document.getElementById('admin-import-run');
const _importSummary = document.getElementById('admin-import-summary');

_importFileInput.addEventListener('change', () => {
  _importPreviewOk = false;
  _importRunBtn.disabled = true;
  _clearNode(_importSummary);
});

_importCheckBtn.addEventListener('click', async () => {
  const file = _importFileInput.files[0];
  if (!file) return;
  _importPreviewOk = false;
  _importRunBtn.disabled = true;
  _importCheckBtn.disabled = true;
  const originalText = _importCheckBtn.textContent;
  _importCheckBtn.textContent = 'Checking…';
  try {
    const text = await file.text();
    const res = await fetch('/api/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const body = await res.json();
    if (res.ok) {
      _renderImportPreview(_importSummary, body);
      _importPreviewOk = true;
      _importRunBtn.disabled = false;
    } else {
      _renderImportError(_importSummary, body);
    }
  } catch (err) {
    _renderImportError(_importSummary, { error: 'Check request failed — nothing was imported. Try again.' });
  } finally {
    _importCheckBtn.disabled = false;
    _importCheckBtn.textContent = originalText;
  }
});

_importRunBtn.addEventListener('click', async () => {
  if (!_importPreviewOk) return;
  const file = _importFileInput.files[0];
  if (!file) return;
  _importCheckBtn.disabled = true;
  _importRunBtn.disabled = true;
  const originalText = _importRunBtn.textContent;
  _importRunBtn.textContent = 'Importing…';
  try {
    const text = await file.text();
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const body = await res.json();
    if (res.ok) {
      _renderImportResult(_importSummary, body);
    } else {
      _renderImportError(_importSummary, body);
    }
  } catch (err) {
    _renderImportError(_importSummary, { error: 'Import request failed — reload the admin page to check whether it applied.' });
  } finally {
    _importPreviewOk = false;
    _importCheckBtn.disabled = false;
    _importRunBtn.textContent = originalText;
    _importRunBtn.disabled = true;
  }
});
