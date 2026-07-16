/* =============================================
   Wishlist
   ============================================= */

let _wishlist = null;
let _wishlistSort = 'default';

async function initWishlist() {
  const res = await fetch('/api/wishlist');
  _wishlist = await res.json();
  _renderWishlist();
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _sortedItems(items) {
  const copy = [...items];
  switch (_wishlistSort) {
    case 'name':       return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'price-asc':  return copy.sort((a, b) => a.price - b.price);
    case 'price-desc': return copy.sort((a, b) => b.price - a.price);
    default:           return copy;
  }
}

function _renderWishlist() {
  const el = document.getElementById('wishlist-list');
  if (!el) return;

  const items = _wishlist?.items || [];
  if (!items.length) {
    el.innerHTML = `<p class="wishlist-empty">${t('wishlist.empty')}</p>`;
    return;
  }

  const remaining  = getBudgetRemaining?.();
  const total      = items.reduce((s, i) => s + i.price, 0);
  const allImpact  = remaining !== null ? remaining - total : null;
  const allImpactClass = allImpact === null ? '' : allImpact >= 0 ? 'positive' : 'negative';
  const countLabel = `${items.length} ${t(items.length === 1 ? 'wishlist.item' : 'wishlist.items')}`;

  const summaryHtml = `
    <div class="wishlist-summary">
      <div class="wishlist-sum-item">
        <span class="wishlist-sum-label">${t('wishlist.total')}</span>
        <span class="wishlist-sum-val">${formatCurrency(total)}</span>
      </div>
      ${allImpact !== null ? `
      <div class="wishlist-sum-item">
        <span class="wishlist-sum-label">${t('wishlist.ifAllBought')}</span>
        <span class="wishlist-sum-val wishlist-impact--${allImpactClass}">${formatCurrency(allImpact)}</span>
      </div>` : ''}
      <span class="wishlist-sum-count">${countLabel}</span>
    </div>`;

  let impactBarHtml = '';
  if (remaining !== null && total > 0) {
    const over = total > remaining;
    const pctCost = remaining > 0 ? Math.min(100, (total / remaining) * 100) : 100;
    const pctSafe = Math.max(0, 100 - pctCost);
    impactBarHtml = `
      <div class="wishlist-budget-bar">
        <div class="wishlist-budget-bar-track">
          <div class="wishlist-budget-bar-safe" style="width:${pctSafe.toFixed(1)}%"></div>
          <div class="wishlist-budget-bar-cost${over ? ' wishlist-budget-bar-cost--over' : ''}" style="width:${pctCost.toFixed(1)}%"></div>
        </div>
      </div>`;
  }

  const sortDefs = [
    ['default',    t('wishlist.sortDefault')],
    ['name',       t('wishlist.sortName')],
    ['price-asc',  t('wishlist.sortPriceAsc')],
    ['price-desc', t('wishlist.sortPriceDesc')],
  ];
  const sortHtml = `
    <div class="wishlist-sort-bar">
      <span class="wishlist-sort-label">${t('wishlist.sortBy')}</span>
      ${sortDefs.map(([key, label]) =>
        `<button class="wishlist-sort-btn${_wishlistSort === key ? ' active' : ''}" data-sort="${key}">${label}</button>`
      ).join('')}
    </div>`;

  const sorted = _sortedItems(items);
  const itemsHtml = sorted.map(item => {
    const impact = (remaining !== null && item.price > 0) ? remaining - item.price : null;
    const impactClass = impact === null ? '' : impact >= 0 ? 'positive' : 'negative';
    const impactHtml = impact !== null
      ? `<span class="wishlist-impact wishlist-impact--${impactClass}">${formatCurrency(impact)} ${t('wishlist.ifBought')}</span>`
      : '';
    const linkHtml = item.url
      ? `<a class="wishlist-link" href="${_escHtml(item.url)}" target="_blank" rel="noopener noreferrer">↗</a>`
      : '';
    const affordDotHtml = (remaining !== null && item.price > 0)
      ? `<span class="wishlist-afford-dot" style="background:${remaining >= item.price ? 'var(--c-stay)' : '#e87a7a'}"></span>`
      : '';

    return `
      <div class="wishlist-item" data-id="${item.id}">
        ${affordDotHtml}
        <div class="wishlist-item-main">
          <span class="wishlist-item-name">${_escHtml(item.name)}</span>
          ${linkHtml}
          ${impactHtml}
        </div>
        <div class="wishlist-item-actions">
          <span class="wishlist-item-price">${item.price > 0 ? formatCurrency(item.price) : '—'}</span>
          <button class="wishlist-buy-btn" data-id="${item.id}" title="${t('wishlist.markBought')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
          <button class="wishlist-delete-btn" data-id="${item.id}" title="${t('modal.delete')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = summaryHtml + impactBarHtml + sortHtml + `<div class="wishlist-items">${itemsHtml}</div>`;

  el.querySelectorAll('.wishlist-sort-btn').forEach(btn =>
    btn.addEventListener('click', () => { _wishlistSort = btn.dataset.sort; _renderWishlist(); }));
  el.querySelectorAll('.wishlist-buy-btn').forEach(btn =>
    btn.addEventListener('click', () => _markBought(btn.dataset.id)));
  el.querySelectorAll('.wishlist-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => _deleteItem(btn.dataset.id)));
}

async function _markBought(id) {
  const item = _wishlist.items.find(i => i.id === id);
  if (!item) return;
  if (!confirm(t('wishlist.buyConfirm', { name: item.name }))) return;
  await fetch(`/api/wishlist/${id}`, { method: 'DELETE' });
  _wishlist.items = _wishlist.items.filter(i => i.id !== id);
  _renderWishlist();
}

async function _deleteItem(id) {
  if (!confirm(t('wishlist.confirmDelete'))) return;
  await fetch(`/api/wishlist/${id}`, { method: 'DELETE' });
  _wishlist.items = _wishlist.items.filter(i => i.id !== id);
  _renderWishlist();
}

// ── Add modal ──────────────────────────────────

let _wishlistMode = 'manual';

function _openWishlistModal() {
  document.getElementById('wishlist-overlay').hidden = false;
  document.getElementById('wishlist-name').value = '';
  document.getElementById('wishlist-price').value = '';
  document.getElementById('wishlist-url-input').value = '';
  document.getElementById('wishlist-fetch-status').textContent = '';
  _setWishlistMode('manual');
  setTimeout(() => document.getElementById('wishlist-name').focus(), 50);
}

function _closeWishlistModal() {
  document.getElementById('wishlist-overlay').hidden = true;
}

function _setWishlistMode(mode) {
  _wishlistMode = mode;
  document.querySelectorAll('#wishlist-mode-selector .type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('wishlist-url-row').hidden = mode !== 'url';
  if (mode === 'url') setTimeout(() => document.getElementById('wishlist-url-input').focus(), 50);
}

async function _fetchUrl() {
  const url = document.getElementById('wishlist-url-input').value.trim();
  if (!url) return;
  const statusEl = document.getElementById('wishlist-fetch-status');
  const btn = document.getElementById('wishlist-fetch-btn');
  statusEl.textContent = t('wishlist.fetching');
  statusEl.className = 'wishlist-fetch-status';
  btn.disabled = true;
  try {
    const r = await fetch('/api/wishlist/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'fetch-failed');
    if (data.name) document.getElementById('wishlist-name').value = data.name;
    if (data.price) document.getElementById('wishlist-price').value = data.price;
    statusEl.textContent = data.price ? '' : t('wishlist.fetchedNoPrice');
  } catch (err) {
    statusEl.textContent = err.message === 'blocked'
      ? t('wishlist.fetchBlocked')
      : t('wishlist.fetchFailed');
    statusEl.className = 'wishlist-fetch-status wishlist-fetch-status--error';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('btn-add-wishlist').addEventListener('click', _openWishlistModal);
document.getElementById('wishlist-modal-close').addEventListener('click', _closeWishlistModal);
document.getElementById('wishlist-cancel-btn').addEventListener('click', _closeWishlistModal);
wireModal(document.getElementById('wishlist-overlay'), _closeWishlistModal);

document.getElementById('wishlist-mode-selector').addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (btn) _setWishlistMode(btn.dataset.mode);
});

document.getElementById('wishlist-fetch-btn').addEventListener('click', _fetchUrl);
document.getElementById('wishlist-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _fetchUrl(); }
});

document.getElementById('wishlist-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name  = document.getElementById('wishlist-name').value.trim();
  const price = parseFloat(document.getElementById('wishlist-price').value) || 0;
  const url   = _wishlistMode === 'url' ? document.getElementById('wishlist-url-input').value.trim() : '';
  if (!name) return;
  try {
    const r = await fetch('/api/wishlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, price, url }),
    });
    _wishlist.items.push(await r.json());
    _closeWishlistModal();
    _renderWishlist();
  } catch { alert(t('modal.saveFailed')); }
});

document.addEventListener('langchange', () => {
  if (_wishlist) _renderWishlist();
});
