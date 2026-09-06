/* =============================================
   Accommodations Insights Page
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

let _accomList = [];
let _accomCurrency = 'EUR';

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _accomFmtMoney(amount) {
  try {
    return new Intl.NumberFormat(getDateLocale(), {
      style: 'currency', currency: _accomCurrency, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return _accomCurrency + ' ' + Math.round(amount).toLocaleString();
  }
}

function _parseLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _nightsFor(stay) {
  return Math.round((_parseLocal(stay.check_out) - _parseLocal(stay.check_in)) / 86400000);
}

// Overlap pairs (duplicated from timeline.js's computeStayIssues — this page
// doesn't load timeline.js): every pair of stays sharing at least one night.
function _overlapsById(stays) {
  const byId = new Map();
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const a = stays[i], b = stays[j];
      const start = a.check_in > b.check_in ? a.check_in : b.check_in;
      const end   = a.check_out < b.check_out ? a.check_out : b.check_out;
      if (start < end) {
        const msg = t('stays.overlap', { a: a.city, b: b.city, start: fmtDate(start, { year: false }), end: fmtDate(end, { year: false }), n: Math.round((_parseLocal(end) - _parseLocal(start)) / 86400000) });
        if (!byId.has(a.id)) byId.set(a.id, []);
        if (!byId.has(b.id)) byId.set(b.id, []);
        byId.get(a.id).push(msg);
        byId.get(b.id).push(msg);
      }
    }
  }
  return byId;
}

function _wireModal(overlay, closeFn) {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFn(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeFn();
  });
}

function _renderStats() {
  const el = document.getElementById('accom-stats-grid');
  const priced = _accomList.filter(a => typeof a.total_price === 'number');
  const totalNights = _accomList.reduce((s, a) => s + _nightsFor(a), 0);
  const totalSpend = priced.reduce((s, a) => s + a.total_price, 0);
  const pricedNights = priced.reduce((s, a) => s + _nightsFor(a), 0);
  const avgPerNight = pricedNights > 0 ? totalSpend / pricedNights : null;
  const missingCount = _accomList.length - priced.length;

  const item = (label, val) => `
    <div class="accom-manifest-item">
      <span class="accom-manifest-label">${label}</span>
      <span class="accom-manifest-val accom-mono">${val}</span>
    </div>`;

  el.innerHTML = [
    item(t('accom.stats.totalNights'), totalNights),
    item(t('accom.stats.totalSpend'), priced.length > 0 ? _accomFmtMoney(totalSpend) : '—'),
    item(t('accom.stats.avgPerNight'), avgPerNight !== null ? _accomFmtMoney(avgPerNight) : '—'),
    item(t('accom.stats.missingPrice'), missingCount),
  ].join('');
}

// Renders each stay as a ticket-stub "manifest row": a color spine matching
// that stay's own identity color from elsewhere in the app (day cards,
// timeline, legend), with dates/nights/price set in a monospace face for a
// printed-ticket feel — replaces the plain HTML table this page started with.
function _renderList() {
  const container = document.getElementById('accom-table-body');
  const sorted = [...(_accomList || [])].sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''));
  const overlaps = _overlapsById(sorted);

  container.innerHTML = sorted.map((a, i) => {
    const nights = _nightsFor(a);
    const hasPrice = typeof a.total_price === 'number';
    const perNight = hasPrice ? a.total_price / nights : null;
    const linkHtml = a.url ? `
      <a class="accom-link-icon" href="${_escHtml(a.url)}" target="_blank" rel="noopener noreferrer" title="${t('accom.col.booking')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
      </a>` : '';
    // A full address already ends with the country name, so only show the
    // separate `country` field when there's no address to fall back on.
    const placeLine = a.address ? _escHtml(a.address) : _escHtml(a.country || '');
    const rowOverlaps = overlaps.get(a.id);

    return `
      <div class="accom-row${rowOverlaps ? ' accom-row--overlap' : ''}" data-id="${a.id}" style="--stay-color:${_escHtml(a.color || '')}">
        <div class="accom-row-main">
          <div class="accom-row-city-line">
            <span class="accom-row-index accom-mono">${String(i + 1).padStart(2, '0')}⁄${sorted.length}</span>
            <span class="accom-row-city">${_escHtml(a.city || '')}</span>
            ${a.geocode_status === 'failed' ? `<span class="accom-geocode-failed" title="${t('accom.geocodeFailed')}">&#9888;</span>` : ''}
            ${rowOverlaps ? `<span class="accom-overlap-flag" title="${_escHtml(rowOverlaps.join('\n'))}">&#9888;</span>` : ''}
          </div>
          <div class="accom-row-place">${placeLine}</div>
        </div>
        <div class="accom-row-figure accom-row-dates">
          <span class="accom-row-figure-label">${t('accom.col.dates')}</span>
          <span class="accom-row-figure-val accom-mono">${fmtDate(a.check_in, { year: false })} → ${fmtDate(a.check_out, { year: false })}</span>
        </div>
        <div class="accom-row-figure accom-row-nights">
          <span class="accom-row-figure-label">${t('accom.col.nights')}</span>
          <span class="accom-row-figure-val accom-mono">${nights}</span>
        </div>
        <div class="accom-row-figure accom-row-total">
          <span class="accom-row-figure-label">${t('accom.col.totalPrice')}</span>
          ${hasPrice
            ? `<span class="accom-row-figure-val accom-mono">${_accomFmtMoney(a.total_price)}</span>`
            : `<span class="accom-row-figure-val accom-no-price">—</span>`}
        </div>
        <div class="accom-row-figure accom-row-pernight">
          <span class="accom-row-figure-label">${t('accom.col.perNight')}</span>
          ${perNight !== null
            ? `<span class="accom-row-figure-val accom-row-figure-val--accent accom-mono">${_accomFmtMoney(perNight)}</span>`
            : `<span class="accom-row-figure-val accom-no-price">—</span>`}
        </div>
        <div class="accom-row-actions">
          ${linkHtml}
          <button class="accom-edit-btn" data-edit-id="${a.id}" title="${t('accom.edit.title')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="accom-delete-btn" data-delete-id="${a.id}" title="${t('modal.delete')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', () => _openEditModal(btn.dataset.editId));
  });
  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', () => _deleteStay(btn.dataset.deleteId));
  });
}

async function _deleteStay(id) {
  if (!confirm(t('modal.confirmDelete'))) return;
  try {
    const r = await fetch(`/api/accommodations/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error();
    _accomList = _accomList.filter(x => x.id !== id);
    _renderStats();
    _renderList();
  } catch { alert(t('modal.saveFailed')); }
}

function _openEditModal(id) {
  const a = _accomList.find(x => x.id === id);
  if (!a) return;
  document.getElementById('accom-id').value = a.id;
  document.getElementById('accom-address').value = a.address || '';
  document.getElementById('accom-total-price').value = typeof a.total_price === 'number' ? a.total_price : '';
  document.getElementById('accom-overlay').hidden = false;
  setTimeout(() => document.getElementById('accom-address').focus(), 50);
}

function _closeEditModal() {
  document.getElementById('accom-overlay').hidden = true;
}

document.getElementById('accom-modal-close').addEventListener('click', _closeEditModal);
document.getElementById('accom-cancel-btn').addEventListener('click', _closeEditModal);
_wireModal(document.getElementById('accom-overlay'), _closeEditModal);

document.getElementById('accom-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('accom-id').value;
  const priceRaw = document.getElementById('accom-total-price').value;
  const payload = {
    address: document.getElementById('accom-address').value.trim(),
    total_price: priceRaw === '' ? null : Number(priceRaw),
  };
  try {
    const r = await fetch(`/api/accommodations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error();
    const updated = await r.json();
    const idx = _accomList.findIndex(x => x.id === id);
    if (idx !== -1) _accomList[idx] = updated;
    _closeEditModal();
    _renderStats();
    _renderList();
  } catch { alert(t('modal.saveFailed')); }
});

document.addEventListener('langchange', () => {
  if (_accomList.length) { _renderStats(); _renderList(); }
});

async function _init() {
  await initI18n();
  const [accomRes, budgetRes] = await Promise.all([
    fetch('/api/accommodations'),
    fetch('/api/budget').catch(() => null),
  ]);
  _accomList = await accomRes.json();
  if (budgetRes && budgetRes.ok) {
    const budget = await budgetRes.json();
    _accomCurrency = budget.currency || 'EUR';
  }
  _renderStats();
  _renderList();
}

_init();
