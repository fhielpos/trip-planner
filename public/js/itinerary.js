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
  const docsRow = (leg.docs && leg.docs.length) ? `
        <div class="bp-docs">
          ${leg.docs.map(d => `<a class="doc-open-link doc-open-link--sm" href="/api/documents/${d.id}/file" target="_blank" rel="noopener noreferrer" title="${_escHtml(d.title)}">📄 ${t('documents.open')}</a>`).join('')}
        </div>` : '';

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
        ${docsRow}
      </div>
      <div class="bp-stub">
        <span class="bp-stub-route accom-mono">${leg.fromCode ? leg.fromCode : _escHtml(leg.fromCity)} → ${leg.toCode ? leg.toCode : _escHtml(leg.toCity)}</span>
        <span class="bp-stub-date accom-mono">${fmtDate(leg.date, { year: false })}</span>
        <span class="bp-stub-icon">${icon}</span>
        <div class="bp-barcode">${_fakeBarcode(index + 1)}</div>
      </div>
    </div>`;
}

let _lastLegs = null;
let _lastDocs = null;
let _docModalInitialLegKeys = new Set();

function _docCardHtml(doc) {
  return `
    <div class="doc-card" data-id="${doc.id}">
      <div class="doc-card-main">
        <span class="doc-card-title">${_escHtml(doc.title)}</span>
        <span class="doc-card-range accom-mono">${fmtDate(doc.valid_from, { year: false })} → ${fmtDate(doc.valid_to, { year: false })}</span>
      </div>
      <div class="doc-card-actions no-print">
        <a class="btn-secondary doc-open-link" href="/api/documents/${doc.id}/file" target="_blank" rel="noopener noreferrer">${t('documents.open')}</a>
        <button type="button" class="doc-edit-btn" data-edit-id="${doc.id}" title="${t('documents.editTitle')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
    </div>`;
}

function _renderDocs(docs) {
  const container = document.getElementById('documents-list');
  if (!docs.length) {
    container.innerHTML = `<p class="doc-empty">${t('documents.empty')}</p>`;
    return;
  }
  container.innerHTML = [...docs]
    .sort((a, b) => a.valid_from.localeCompare(b.valid_from))
    .map(_docCardHtml).join('');
  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => _openDocModal(btn.dataset.editId));
  });
}

function _legsPickerHtml(legs) {
  const group = (label, list) => list.length ? `
    <div class="doc-legs-group-label">${label}</div>
    ${list.map(l => `
      <label class="doc-leg-option">
        <input type="checkbox" value="${l.mode}:${l.id}" />
        <span>${l.mode === 'flight' ? '✈️' : '🚆'} ${_escHtml(l.fromCity)} → ${_escHtml(l.toCity)} <span class="accom-mono">· ${fmtDate(l.date, { year: false })}</span></span>
      </label>`).join('')}` : '';
  return group(t('map.legendFlight'), legs.filter(l => l.mode === 'flight'))
       + group(t('map.legendTrain'),  legs.filter(l => l.mode === 'train'));
}

function _recomputeLegDocs() {
  const docsById = Object.fromEntries((_lastDocs || []).map(d => [d.id, d]));
  (_lastLegs || []).forEach(l => {
    l.docs = (l.document_ids || []).map(docId => docsById[docId]).filter(Boolean);
  });
}

function _wireModal(overlay, closeFn) {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFn(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeFn();
  });
}

function _openDocModal(id) {
  const overlay = document.getElementById('doc-overlay');
  const titleEl = document.getElementById('doc-modal-title');
  const deleteBtn = document.getElementById('doc-delete-btn');
  const urlRow = document.getElementById('doc-url-row');
  const urlInput = document.getElementById('doc-url');
  const pickerEl = document.getElementById('doc-legs-picker');

  document.getElementById('doc-form').reset();
  document.getElementById('doc-id').value = '';
  pickerEl.innerHTML = _legsPickerHtml(_lastLegs || []);

  if (id) {
    const doc = (_lastDocs || []).find(d => d.id === id);
    if (!doc) return;
    titleEl.textContent = t('documents.editTitle');
    document.getElementById('doc-id').value = doc.id;
    document.getElementById('doc-title').value = doc.title;
    document.getElementById('doc-valid-from').value = doc.valid_from;
    document.getElementById('doc-valid-to').value = doc.valid_to;
    urlRow.hidden = true;
    urlInput.required = false;
    deleteBtn.hidden = false;
    _docModalInitialLegKeys = new Set(
      (_lastLegs || [])
        .filter(l => (l.document_ids || []).includes(id))
        .map(l => `${l.mode}:${l.id}`)
    );
  } else {
    titleEl.textContent = t('documents.add');
    urlRow.hidden = false;
    urlInput.required = true;
    deleteBtn.hidden = true;
    _docModalInitialLegKeys = new Set();
  }
  pickerEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = _docModalInitialLegKeys.has(cb.value);
  });

  overlay.hidden = false;
  setTimeout(() => document.getElementById('doc-title').focus(), 50);
}

function _closeDocModal() {
  document.getElementById('doc-overlay').hidden = true;
}

document.getElementById('btn-add-document').addEventListener('click', () => _openDocModal(null));
document.getElementById('doc-modal-close').addEventListener('click', _closeDocModal);
document.getElementById('doc-cancel-btn').addEventListener('click', _closeDocModal);
_wireModal(document.getElementById('doc-overlay'), _closeDocModal);

document.getElementById('doc-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('doc-id').value;
  const saveBtn = document.getElementById('doc-save-btn');
  saveBtn.disabled = true;
  try {
    let docId = id;
    if (id) {
      const payload = {
        title: document.getElementById('doc-title').value.trim(),
        valid_from: document.getElementById('doc-valid-from').value,
        valid_to: document.getElementById('doc-valid-to').value,
      };
      const r = await fetch(`/api/documents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error();
      const updated = await r.json();
      const idx = _lastDocs.findIndex(d => d.id === id);
      if (idx !== -1) _lastDocs[idx] = updated;
    } else {
      const payload = {
        title: document.getElementById('doc-title').value.trim(),
        source_url: document.getElementById('doc-url').value.trim(),
        valid_from: document.getElementById('doc-valid-from').value,
        valid_to: document.getElementById('doc-valid-to').value,
      };
      const r = await fetch('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error();
      const created = await r.json();
      _lastDocs.push(created);
      docId = created.id;
    }

    const pickerEl = document.getElementById('doc-legs-picker');
    const newKeys = new Set(
      [...pickerEl.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value)
    );
    const changed = new Set([
      ...[...newKeys].filter(k => !_docModalInitialLegKeys.has(k)),
      ...[..._docModalInitialLegKeys].filter(k => !newKeys.has(k)),
    ]);
    for (const key of changed) {
      const [mode, legId] = key.split(':');
      const leg = (_lastLegs || []).find(l => l.mode === mode && l.id === legId);
      if (!leg) continue;
      const nextIds = new Set(leg.document_ids || []);
      if (newKeys.has(key)) nextIds.add(docId); else nextIds.delete(docId);
      const endpoint = mode === 'flight' ? `/api/flights/${legId}` : `/api/trains/${legId}`;
      const r = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: [...nextIds] }),
      });
      if (r.ok) leg.document_ids = [...nextIds];
    }
    _recomputeLegDocs();
    _closeDocModal();
    _renderDocs(_lastDocs);
    _render(_lastLegs);
  } catch {
    alert(t('modal.saveFailed'));
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById('doc-delete-btn').addEventListener('click', async () => {
  const id = document.getElementById('doc-id').value;
  if (!id || !confirm(t('documents.confirmDelete'))) return;
  try {
    const r = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
    _lastDocs = _lastDocs.filter(d => d.id !== id);
    for (const leg of (_lastLegs || [])) {
      if (!(leg.document_ids || []).includes(id)) continue;
      const nextIds = leg.document_ids.filter(docId => docId !== id);
      const endpoint = leg.mode === 'flight' ? `/api/flights/${leg.id}` : `/api/trains/${leg.id}`;
      const pr = await fetch(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: nextIds }),
      });
      if (pr.ok) leg.document_ids = nextIds;
    }
    _recomputeLegDocs();
    _closeDocModal();
    _renderDocs(_lastDocs);
    _render(_lastLegs);
  } catch {
    alert(t('modal.deleteFailed'));
  }
});

document.addEventListener('langchange', () => {
  if (_lastLegs) _render(_lastLegs);
  if (_lastDocs) _renderDocs(_lastDocs);
});

function _render(legs) {
  document.getElementById('itinerary-list').innerHTML =
    legs.map((leg, i) => _boardingPassHtml(leg, i, legs.length)).join('');
}

async function _init() {
  await initI18n();
  const [tripRes, docsRes, flightsRes] = await Promise.all([
    fetch('/api/trip'),
    fetch('/api/documents'),
    fetch('/api/flights'),
  ]);
  const trip = await tripRes.json();
  _lastDocs = await docsRes.json();
  const flights = await flightsRes.json();
  _renderDocs(_lastDocs);

  const flightLegs = flights.map(f => ({
    mode: 'flight', id: f.id, document_ids: f.document_ids || [],
    fromCity: f.fromCity, toCity: f.toCity,
    fromCode: f.from, toCode: f.to,
    date: f.departureDate,
    departureTime: f.departureTime, arrivalTime: f.arrivalTime,
    flightNumber: f.flightNumber,
  }));
  const trainLegs = (trip.trains || []).map(tr => ({
    mode: 'train', id: tr.id, document_ids: tr.document_ids || [],
    fromCity: tr.fromCity, toCity: tr.toCity,
    fromCode: null, toCode: null,
    date: tr.departureDate,
    departureTime: tr.departureTime, arrivalTime: tr.arrivalTime,
    notes: tr.notes,
  }));
  const legs = [...flightLegs, ...trainLegs].sort((a, b) => a.date.localeCompare(b.date));

  _lastLegs = legs;
  _recomputeLegDocs();
  _render(legs);
}

_init();
