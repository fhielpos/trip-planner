/* =============================================
   Budget Tracker
   ============================================= */

const BUDGET_CATEGORIES = ['food', 'transport', 'accommodation', 'activities', 'shopping', 'other'];

const BUDGET_CAT_COLORS = {
  food:          '#d8b47a',
  transport:     '#8ec8de',
  accommodation: '#8ec8b0',
  activities:    '#bea8d8',
  shopping:      '#e8a0a0',
  other:         '#b0a898',
};

// Trip countries → currency, used to auto-suggest an expense's currency
// from the city active on its date (same idea as the existing date→city
// autofill). Falls back to the budget's own currency for anything unlisted.
const COUNTRY_CURRENCY = {
  Argentina: 'ARS',
  France: 'EUR',
  Greece: 'EUR',
  Austria: 'EUR',
  Germany: 'EUR',
  Switzerland: 'CHF',
  Netherlands: 'EUR',
  Belgium: 'EUR',
};

let _budget = null;
let _budgetTrip = null;
let _catRowSeq = 0;
let _entriesSort = 'date';
// Collapsed-group keys, shared across sort modes — keys from one mode
// (date strings, city names, category ids) never collide with another's,
// so a stale key from a previous mode is just inert, not worth clearing.
const _collapsedGroups = new Set();

const PENDING_ENTRIES_KEY = 'pendingBudgetEntries';

function _loadPendingEntries() {
  try { return JSON.parse(localStorage.getItem(PENDING_ENTRIES_KEY)) || []; }
  catch { return []; }
}

function _savePendingEntries(list) {
  localStorage.setItem(PENDING_ENTRIES_KEY, JSON.stringify(list));
}

function _queuePendingEntry(payload) {
  const tempId = 'pending-' + Date.now();
  const pending = _loadPendingEntries();
  pending.push({ tempId, payload });
  _savePendingEntries(pending);
  _budget.entries.push({ ...payload, id: tempId, pending: true });
}

let _syncInFlight = false;

async function _syncPendingEntries() {
  if (_syncInFlight) return;
  _syncInFlight = true;
  try {
    const pending = _loadPendingEntries();
    if (!pending.length) return;
    const remaining = [];
    for (const item of pending) {
      try {
        const r = await fetch('/api/budget/entries', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload),
        });
        const saved = await r.json();
        const idx = _budget.entries.findIndex(e => e.id === item.tempId);
        if (idx !== -1) _budget.entries[idx] = saved;
      } catch {
        remaining.push(item);
      }
    }
    _savePendingEntries(remaining);
    _renderBudget();
  } finally {
    _syncInFlight = false;
  }
}

window.addEventListener('online', _syncPendingEntries);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) _syncPendingEntries();
});

// Predefined category colors — the calendar location accents (see PALETTE in app.js)
const CATEGORY_SWATCHES = [
  '#d46a5a', '#c8b230', '#a060c0', '#38a0a8', '#d05070', '#78b038',
  '#5060c8', '#e09040', '#c050a0', '#38a870', '#6aaec4',
];

// ── Categories (built-in + user-defined) ───────

function _customCats() { return _budget?.categories || []; }
function _allCatIds() {
  const ids = [...BUDGET_CATEGORIES.filter(c => c !== 'other'), ..._customCats().map(c => c.id)];
  ids.sort((a, b) => _catName(a).localeCompare(_catName(b)));
  return [...ids, 'other'];
}
function _catName(id) {
  const c = _customCats().find(c => c.id === id);
  if (c) return c.name;
  return BUDGET_CATEGORIES.includes(id) ? t('budget.cat.' + id) : id;
}
function _catColor(id) {
  const c = _customCats().find(c => c.id === id);
  if (c) return c.color;
  return BUDGET_CAT_COLORS[id] || '#9a9080';
}

async function initBudget(tripData) {
  _budgetTrip = tripData;
  try {
    const res = await fetch('/api/budget');
    _budget = await res.json();
  } catch {
    _budget = { initialBudget: 0, currency: 'EUR', entries: [], subBudgets: [], categories: [] };
  }
  if (!_budget.subBudgets) _budget.subBudgets = [];
  if (!_budget.categories) _budget.categories = [];
  for (const item of _loadPendingEntries()) {
    _budget.entries.push({ ...item.payload, id: item.tempId, pending: true });
  }
  _renderBudget();
  if (navigator.onLine) _syncPendingEntries();
}

// ── Helpers ────────────────────────────────────

function _computeStats() {
  const trip = _budgetTrip.trip;
  const today = appToday();

  const initialBudget = toUSD(_budget.initialBudget, _budget.initialBudgetCurrency);
  const { entries } = _budget;
  const totalSpent = entries.reduce((s, e) => s + toUSD(e.amount, e.currency, e.rate), 0);
  const remaining  = initialBudget - totalSpent;

  const tripStart = parseLocal(trip.startDate);
  const tripEnd   = parseLocal(trip.endDate);
  const tripTotalDays = Math.round((tripEnd - tripStart) / 86400000) + 1;

  const todayDate     = parseLocal(today);
  const cappedToday   = todayDate < tripStart ? tripStart : todayDate > tripEnd ? tripEnd : todayDate;
  const daysElapsed   = Math.max(1, Math.round((cappedToday - tripStart) / 86400000) + 1);
  const daysRemaining = todayDate < tripStart
    ? tripTotalDays
    : Math.max(0, Math.round((tripEnd - todayDate) / 86400000));

  const dailyAvg  = totalSpent > 0 ? totalSpent / daysElapsed : 0;
  const weeklyAvg = dailyAvg * 7;
  const projectedTotal     = dailyAvg > 0 ? dailyAvg * tripTotalDays : 0;
  const projectedRemaining = initialBudget > 0 && projectedTotal > 0 ? initialBudget - projectedTotal : null;

  const pctSpent = initialBudget > 0 ? Math.min(110, (totalSpent / initialBudget) * 100) : 0;

  const dailyBudgetLeft = daysRemaining > 0 ? remaining / daysRemaining : null;

  return {
    initialBudget, totalSpent, remaining, dailyAvg, weeklyAvg,
    projectedTotal, projectedRemaining, tripTotalDays, daysElapsed, daysRemaining, pctSpent,
    dailyBudgetLeft,
  };
}

function _cityForDate(dateStr) {
  return getActiveStay(_budgetTrip?.accommodations || [], dateStr)?.city || '';
}

function _currencyForDate(dateStr) {
  const country = getActiveStay(_budgetTrip?.accommodations || [], dateStr)?.country;
  return COUNTRY_CURRENCY[country] || _budget.initialBudgetCurrency || 'EUR';
}

// Unique trip cities, in itinerary order (accommodations.json is sorted by check_in).
function _tripCities() {
  const seen = new Set();
  const cities = [];
  for (const a of _budgetTrip?.accommodations || []) {
    if (!seen.has(a.city)) { seen.add(a.city); cities.push(a.city); }
  }
  return cities;
}

function _renderCitySelect(selected) {
  const el = document.getElementById('budget-city');
  const cities = _tripCities();
  // Preserve pre-existing values that don't match any trip city (e.g. legacy free-text entries).
  if (selected && !cities.includes(selected)) cities.push(selected);
  const options = [`<option value="">${t('budget.entry.cityNone')}</option>`,
    ...cities.map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`)];
  el.innerHTML = options.join('');
  el.value = selected || '';
}

function _getSelectedCurrency() {
  const active = document.querySelector('#budget-currency-selector .type-btn.active[data-currency]');
  if (active) return active.dataset.currency;
  const select = document.getElementById('budget-currency-select');
  return select.hidden ? 'USD' : select.value;
}

function _setSelectedCurrency(code) {
  const buttons = document.querySelectorAll('#budget-currency-selector .type-btn[data-currency]');
  const select = document.getElementById('budget-currency-select');
  const isQuickPick = CURRENCY_QUICK_PICKS.includes(code);
  buttons.forEach(b => b.classList.toggle('active', isQuickPick && b.dataset.currency === code));
  document.getElementById('budget-currency-more').classList.toggle('active', !isQuickPick);
  if (isQuickPick) {
    select.hidden = true;
  } else {
    const known = listKnownCurrencies();
    const codes = known.includes(code) ? known : [...known, code].sort();
    select.innerHTML = codes.map(c => `<option value="${c}"${c === code ? ' selected' : ''}>${c}</option>`).join('');
    select.hidden = false;
  }
  // Reference-only placeholder (never a submitted default) showing today's
  // effective rate for whichever currency is now selected.
  const info = getRateInfo(code);
  document.getElementById('budget-rate-input').placeholder = info.effective !== null ? info.effective.toFixed(4) : '';
}

function _setCustomRate(rate) {
  const details = document.getElementById('budget-rate-details');
  const input = document.getElementById('budget-rate-input');
  if (rate) {
    details.open = true;
    input.value = rate;
  } else {
    details.open = false;
    input.value = '';
  }
}

function _getCustomRate() {
  const details = document.getElementById('budget-rate-details');
  if (!details.open) return null;
  const val = parseFloat(document.getElementById('budget-rate-input').value);
  return Number.isFinite(val) && val > 0 ? val : null;
}

// ── Render ─────────────────────────────────────

function _renderBudget() {
  _renderStats();
  _renderSubBudgets();
  _renderCategories();
  _renderEntries();
  // Budget data arrives after the first Today render; keep its budget line in sync.
  if (typeof renderToday === 'function' && _budgetTrip) renderToday(_budgetTrip);
}

function _renderStats() {
  const el = document.getElementById('budget-stats-grid');
  if (!el) return;

  if (!_budget.initialBudget) {
    el.innerHTML = `<div class="budget-empty">${t('budget.noBudget')}</div>`;
    return;
  }

  const s = _computeStats();
  const remClass  = s.remaining >= 0 ? 'positive' : 'negative';

  if (isMobileViewport()) {
    el.innerHTML = `
      <div class="mbudget-stats">
        <div class="mbudget-stat mbudget-stat--accent"><div class="mbudget-stat-label">${t('budget.stats.budget')}</div><div class="mbudget-stat-val">${formatCurrency(s.initialBudget)}</div></div>
        <div class="mbudget-stat"><div class="mbudget-stat-label">${t('budget.stats.spent')}</div><div class="mbudget-stat-val">${formatCurrency(s.totalSpent)}</div></div>
        <div class="mbudget-stat mbudget-stat--${remClass}"><div class="mbudget-stat-label">${t('budget.stats.remaining')}</div><div class="mbudget-stat-val mbudget-stat-val--${remClass}">${formatCurrency(s.remaining)}</div></div>
      </div>`;
    registerMobileRerender(() => _renderStats());
    return;
  }

  const projClass = s.projectedRemaining === null ? '' : s.projectedRemaining >= 0 ? 'positive' : 'negative';
  const barColor  = s.pctSpent < 75 ? 'var(--c-stay)' : s.pctSpent < 100 ? 'var(--accent)' : 'var(--c-flight--neg, #e87a7a)';

  el.innerHTML = `
    <div class="budget-stats-main">
      <div class="budget-stat-card budget-stat-card--accent">
        <span class="budget-stat-label">${t('budget.stats.budget')}</span>
        <span class="budget-stat-val">${formatCurrency(s.initialBudget)}</span>
      </div>
      <div class="budget-stat-card">
        <span class="budget-stat-label">${t('budget.stats.spent')}</span>
        <span class="budget-stat-val">${formatCurrency(s.totalSpent)}</span>
      </div>
      <div class="budget-stat-card budget-stat-card--${remClass}">
        <span class="budget-stat-label">${t('budget.stats.remaining')}</span>
        <span class="budget-stat-val budget-val--${remClass}">${formatCurrency(s.remaining)}</span>
      </div>
      <div class="budget-stat-card${projClass ? ' budget-stat-card--' + projClass : ''}">
        <span class="budget-stat-label">${t('budget.stats.projected')}</span>
        <span class="budget-stat-val${projClass ? ' budget-val--' + projClass : ''}">${s.projectedTotal > 0 ? formatCurrency(s.projectedTotal) : '—'}</span>
      </div>
    </div>

    <div class="budget-progress-track">
      <div class="budget-progress-fill" style="width:${s.pctSpent.toFixed(1)}%; background:${barColor}"></div>
    </div>

    <div class="budget-stats-secondary">
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.dailyAvg')}</span>
        <span class="budget-sec-val">${s.dailyAvg > 0 ? formatCurrency(s.dailyAvg) : '—'}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.weeklyAvg')}</span>
        <span class="budget-sec-val">${s.weeklyAvg > 0 ? formatCurrency(s.weeklyAvg) : '—'}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.dailyLeft')}</span>
        <span class="budget-sec-val${s.dailyBudgetLeft !== null && s.dailyBudgetLeft < 0 ? ' budget-val--negative' : ''}">${s.dailyBudgetLeft !== null ? formatCurrency(s.dailyBudgetLeft) : '—'}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.progress')}</span>
        <span class="budget-sec-val">${t('budget.stats.dayOf', { day: s.daysElapsed, total: s.tripTotalDays })}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.daysLeft')}</span>
        <span class="budget-sec-val">${s.daysRemaining}</span>
      </div>
      ${s.projectedRemaining !== null ? `
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.projectedLeft')}</span>
        <span class="budget-sec-val budget-val--${projClass}">${formatCurrency(s.projectedRemaining)}</span>
      </div>` : ''}
    </div>
  `;
}

function _renderSubBudgets() {
  const el = document.getElementById('budget-subbudgets');
  if (!el) return;

  const subs = _budget.subBudgets || [];
  if (!subs.length || !_budget.initialBudget) { el.innerHTML = ''; return; }

  const spentByCat = {};
  for (const e of _budget.entries) {
    spentByCat[e.category] = (spentByCat[e.category] || 0) + toUSD(e.amount, e.currency, e.rate);
  }

  const order = _allCatIds();
  const sorted = [...subs].sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category)
  );

  const rows = sorted.map(sub => {
    const capUSD = toUSD(sub.amount, _budget.initialBudgetCurrency);
    const spent = spentByCat[sub.category] || 0;
    const pct   = capUSD > 0 ? (spent / capUSD) * 100 : 0;
    const over  = spent > capUSD;
    const color = pct < 75 ? 'var(--c-stay)' : pct < 100 ? 'var(--accent)' : 'var(--c-flight--neg, #e87a7a)';
    return `
      <div class="budget-cat-row">
        <span class="budget-cat-dot" style="background:${_catColor(sub.category)}"></span>
        <span class="budget-cat-name">${_catName(sub.category)}</span>
        <div class="budget-cat-track">
          <div class="budget-cat-fill" style="width:${Math.min(100, pct).toFixed(1)}%; background:${color}"></div>
        </div>
        <span class="budget-cat-amt${over ? ' budget-val--negative' : ''}">${formatCurrency(spent)} / ${formatCurrency(capUSD)}</span>
        <span class="budget-cat-pct${over ? ' budget-val--negative' : ''}">${pct.toFixed(0)}%</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-block">
      <h3 class="budget-sub-title">${t('budget.sub.title')}</h3>
      ${rows}
    </div>`;
}

function _renderCategories() {
  const el = document.getElementById('budget-categories-bar');
  if (!el) return;

  const { entries } = _budget;
  if (!entries.length || !_budget.initialBudget) { el.innerHTML = ''; return; }

  const totals = {};
  let grandTotal = 0;
  for (const e of entries) {
    const usd = toUSD(e.amount, e.currency, e.rate);
    totals[e.category] = (totals[e.category] || 0) + usd;
    grandTotal += usd;
  }

  const sorted = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!sorted.length) { el.innerHTML = ''; return; }

  const stackedSegments = sorted.map(cat => {
    const pct = ((totals[cat] / grandTotal) * 100).toFixed(1);
    return `<div class="budget-stacked-segment"
      style="width:${pct}%;background:${_catColor(cat)}"
      title="${_catName(cat)}: ${formatCurrency(totals[cat])} (${pct}%)"></div>`;
  }).join('');

  const rows = sorted.map(cat => {
    const pct = ((totals[cat] / grandTotal) * 100).toFixed(0);
    return `
      <div class="budget-cat-row">
        <span class="budget-cat-dot" style="background:${_catColor(cat)}"></span>
        <span class="budget-cat-name">${_catName(cat)}</span>
        <div class="budget-cat-track">
          <div class="budget-cat-fill" style="width:${pct}%; background:${_catColor(cat)}"></div>
        </div>
        <span class="budget-cat-amt">${formatCurrency(totals[cat])}</span>
        <span class="budget-cat-pct">${pct}%</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-block">
      <h3 class="budget-sub-title">${t('budget.categories.title')}</h3>
      <div class="budget-stacked-bar">${stackedSegments}</div>
      ${rows}
    </div>`;
}

// Groups entries by the active sort key (date/city/category), each group
// carrying its own total — city/category groups sort by total descending
// ("where did the money go" is the point of those views); date groups keep
// the original newest-first order. Entries with no city fall into an
// "Unassigned" bucket that's always sorted last regardless of its total.
function _groupEntries(entries) {
  const groups = {};
  const order = [];
  for (const e of entries) {
    let key, label, color = null, isUnassigned = false;
    if (_entriesSort === 'city') {
      key = e.city || '__unassigned__';
      label = e.city || t('budget.entries.unassigned');
      isUnassigned = !e.city;
    } else if (_entriesSort === 'category') {
      key = e.category;
      label = _catName(e.category);
      color = _catColor(e.category);
    } else {
      key = e.date;
      const dow = parseLocal(e.date).toLocaleDateString(getDateLocale(), { weekday: 'short' });
      label = `${dow}, ${fmtDate(e.date)}`;
    }
    if (!groups[key]) { groups[key] = { key, label, color, isUnassigned, entries: [], total: 0 }; order.push(key); }
    groups[key].entries.push(e);
    groups[key].total += toUSD(e.amount, e.currency, e.rate);
  }

  const list = order.map(k => groups[k]);
  if (_entriesSort === 'date') {
    list.sort((a, b) => b.key.localeCompare(a.key));
  } else {
    list.sort((a, b) => (a.isUnassigned ? 1 : b.isUnassigned ? -1 : b.total - a.total));
  }
  for (const g of list) {
    g.entries.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }
  return list;
}

function _renderEntries() {
  const el = document.getElementById('budget-entries-list');
  if (!el) return;

  const { entries } = _budget;
  if (!entries.length) {
    el.innerHTML = `<p class="budget-empty">${t('budget.entries.empty')}</p>`;
    return;
  }

  const sortDefs = [
    ['date',     t('budget.entries.sortDate')],
    ['city',     t('budget.entries.sortCity')],
    ['category', t('budget.entries.sortCategory')],
  ];
  const groups = _groupEntries(entries);
  const allCollapsed = groups.every(g => _collapsedGroups.has(g.key));
  const sortHtml = `
    <div class="wishlist-sort-bar">
      <span class="wishlist-sort-label">${t('budget.entries.sortBy')}</span>
      ${sortDefs.map(([key, label]) =>
        `<button class="wishlist-sort-btn${_entriesSort === key ? ' active' : ''}" data-sort="${key}">${label}</button>`
      ).join('')}
      <button type="button" class="wishlist-sort-btn budget-collapse-all-btn" id="budget-collapse-all">
        ${allCollapsed ? t('budget.entries.expandAll') : t('budget.entries.collapseAll')}
      </button>
    </div>`;

  const rows = groups.map(g => {
    const collapsed = _collapsedGroups.has(g.key);
    const eRows = g.entries.map(e => `
      <div class="budget-entry${e.pending ? ' is-pending' : ''}" data-id="${e.id}">
        <span class="budget-entry-dot" style="background:${_catColor(e.category)}"></span>
        <div class="budget-entry-info">
          <span class="budget-entry-desc">${e.description || _catName(e.category)}</span>
          ${e.city ? `<span class="budget-entry-city">${e.city}</span>` : ''}
        </div>
        <div class="budget-entry-amount-col">
          <span class="budget-entry-amount">${formatMoney(e.amount, e.currency)}${e.rate ? `<span class="rate-chip" title="${t('budget.entry.customRateTooltip', { rate: e.rate })}">@${e.rate}</span>` : ''}</span>
          ${conversionLine(e.amount, e.currency, e.rate)}
        </div>
      </div>`).join('');

    return `
      <div class="budget-day-group">
        <div class="budget-day-header">
          <button type="button" class="budget-group-toggle${collapsed ? '' : ' is-expanded'}" data-key="${g.key.replace(/"/g, '&quot;')}" aria-label="${t('budget.entries.toggleGroup')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
          </button>
          <span class="budget-day-label">${g.color ? `<span class="budget-group-dot" style="background:${g.color}"></span>` : ''}${g.label}</span>
          <span class="budget-day-total">${formatCurrency(g.total)}</span>
        </div>
        <div class="budget-group-entries"${collapsed ? ' hidden' : ''}>${eRows}</div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-block">
      <h3 class="budget-sub-title">${t('budget.entries.title')}</h3>
      ${sortHtml}
      ${rows}
    </div>`;

  el.querySelectorAll('.budget-entry').forEach(row => {
    row.addEventListener('click', () => {
      if (row.classList.contains('is-pending')) { alert(t('offline.pendingEntry')); return; }
      _openExpenseModal(row.dataset.id);
    });
  });

  el.querySelectorAll('.wishlist-sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => { _entriesSort = btn.dataset.sort; _renderEntries(); });
  });

  document.getElementById('budget-collapse-all')?.addEventListener('click', () => {
    if (allCollapsed) groups.forEach(g => _collapsedGroups.delete(g.key));
    else groups.forEach(g => _collapsedGroups.add(g.key));
    _renderEntries();
  });

  el.querySelectorAll('.budget-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const panel = btn.closest('.budget-day-group').querySelector('.budget-group-entries');
      const nowExpanded = panel.hidden;
      panel.hidden = !nowExpanded;
      btn.classList.toggle('is-expanded', nowExpanded);
      if (nowExpanded) _collapsedGroups.delete(key); else _collapsedGroups.add(key);
    });
  });
}

// ── Expense modal ──────────────────────────────

function _getSelectedCat() {
  return document.querySelector('#budget-cat-selector .type-btn.active')?.dataset.cat || 'other';
}

function _renderCatSelector() {
  const el = document.getElementById('budget-cat-selector');
  el.innerHTML = _allCatIds().map(id =>
    `<button type="button" class="type-btn" data-cat="${id}">${_catName(id)}</button>`
  ).join('');
}

function _setSelectedCat(cat) {
  document.querySelectorAll('#budget-cat-selector .type-btn').forEach(b => {
    const active = b.dataset.cat === cat;
    b.classList.toggle('active', active);
    // Custom categories have no CSS active rule — highlight them inline from their color
    if (active && !BUDGET_CATEGORIES.includes(b.dataset.cat)) {
      const c = _catColor(b.dataset.cat);
      b.style.background = c + '38';
      b.style.borderColor = c;
      b.style.color = c;
    } else {
      b.style.background = b.style.borderColor = b.style.color = '';
    }
  });
}

function _openExpenseModal(id) {
  const overlay  = document.getElementById('budget-overlay');
  const titleEl  = document.getElementById('budget-modal-title');
  const deleteBtn = document.getElementById('budget-delete-btn');

  document.getElementById('budget-form').reset();
  document.getElementById('budget-entry-id').value = '';
  _renderCatSelector();

  if (id) {
    const entry = _budget.entries.find(e => e.id === id);
    if (!entry) return;
    titleEl.textContent = t('budget.entry.edit');
    document.getElementById('budget-entry-id').value  = id;
    document.getElementById('budget-date').value       = entry.date;
    document.getElementById('budget-amount').value     = entry.amount;
    document.getElementById('budget-description').value = entry.description || '';
    _renderCitySelect(entry.city || '');
    _setSelectedCat(entry.category);
    _setSelectedCurrency(entry.currency || 'USD');
    _setCustomRate(entry.rate || null);
    deleteBtn.hidden = false;
  } else {
    titleEl.textContent = t('budget.entry.add');
    const today = appToday();
    document.getElementById('budget-date').value = today;
    _renderCitySelect(_cityForDate(today));
    _setSelectedCat('food');
    _setSelectedCurrency(_currencyForDate(today));
    _setCustomRate(null);
    deleteBtn.hidden = true;
  }

  overlay.hidden = false;
  setTimeout(() => document.getElementById('budget-amount').focus(), 50);
}

function _closeExpenseModal() {
  document.getElementById('budget-overlay').hidden = true;
}

// ── Settings modal ─────────────────────────────

function _catOptions(selected) {
  return _allCatIds().map(cat =>
    `<option value="${cat}"${cat === selected ? ' selected' : ''}>${_catName(cat)}</option>`
  ).join('');
}

function _swatchStrip(selected) {
  return CATEGORY_SWATCHES.map(c =>
    `<button type="button" class="cat-swatch${c === selected ? ' selected' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`
  ).join('');
}

function _addCategoryRow(id, name, color) {
  const container = document.getElementById('settings-categories');
  const chosen = CATEGORY_SWATCHES.includes(color) ? color : CATEGORY_SWATCHES[0];
  const row = document.createElement('div');
  row.className = 'category-edit-row';
  row.dataset.id = id;
  row.dataset.color = chosen;
  row.innerHTML = `
    <div class="category-edit-top">
      <input type="text" class="category-name" placeholder="${t('budget.cats.namePlaceholder')}" />
      <button type="button" class="subbudget-remove" aria-label="remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
    <div class="cat-swatches">${_swatchStrip(chosen)}</div>`;
  row.querySelector('.category-name').value = name || '';
  container.appendChild(row);
}

function _addSubBudgetRow(category, amount) {
  const container = document.getElementById('settings-subbudgets');
  const row = document.createElement('div');
  row.className = 'subbudget-edit-row';
  row.innerHTML = `
    <select class="form-select subbudget-cat">${_catOptions(category)}</select>
    <input type="number" class="subbudget-amt" min="0" step="10" placeholder="0" value="${amount != null ? amount : ''}" />
    <button type="button" class="subbudget-remove" aria-label="remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>`;
  container.appendChild(row);
}

function _openSettingsModal() {
  document.getElementById('settings-initial-budget').value = _budget.initialBudget || '';
  document.getElementById('settings-currency').value = _budget.initialBudgetCurrency || 'EUR';
  _renderRatesAdvanced();
  const catContainer = document.getElementById('settings-categories');
  catContainer.innerHTML = '';
  (_budget.categories || []).forEach(c => _addCategoryRow(c.id, c.name, c.color));

  const container = document.getElementById('settings-subbudgets');
  container.innerHTML = '';
  (_budget.subBudgets || []).forEach(s => _addSubBudgetRow(s.category, s.amount));
  document.getElementById('budget-settings-overlay').hidden = false;
}

function _closeSettingsModal() {
  document.getElementById('budget-settings-overlay').hidden = true;
}

// ── Event wiring ───────────────────────────────

document.getElementById('btn-add-expense').addEventListener('click', () => _openExpenseModal(null));
document.getElementById('mbudget-add-btn')?.addEventListener('click', () => _openExpenseModal(null));
document.getElementById('btn-budget-settings').addEventListener('click', _openSettingsModal);

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mbudget-header [data-goto-tab]').forEach(btn =>
    btn.addEventListener('click', () => setMobileTab(btn.dataset.gotoTab)));
});

document.getElementById('budget-modal-close').addEventListener('click', _closeExpenseModal);
document.getElementById('budget-cancel-btn').addEventListener('click', _closeExpenseModal);
wireModal(document.getElementById('budget-overlay'), _closeExpenseModal);

document.getElementById('budget-cat-selector').addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (btn) _setSelectedCat(btn.dataset.cat);
});

document.getElementById('budget-currency-selector').addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  if (btn.id === 'budget-currency-more') {
    _setSelectedCurrency(listKnownCurrencies()[0] || 'GBP');
    document.getElementById('budget-currency-select').focus();
  } else {
    _setSelectedCurrency(btn.dataset.currency);
  }
  _setCustomRate(null);
});
document.getElementById('budget-currency-select').addEventListener('change', e => {
  _setSelectedCurrency(e.target.value);
  _setCustomRate(null);
});

document.getElementById('budget-date').addEventListener('change', e => {
  const city = _cityForDate(e.target.value);
  if (city) document.getElementById('budget-city').value = city;
  _setSelectedCurrency(_currencyForDate(e.target.value));
  _setCustomRate(null);
});

document.getElementById('budget-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('budget-entry-id').value;
  const payload = {
    date:        document.getElementById('budget-date').value,
    amount:      parseFloat(document.getElementById('budget-amount').value),
    currency:    _getSelectedCurrency(),
    rate:        _getCustomRate(),
    category:    _getSelectedCat(),
    description: document.getElementById('budget-description').value.trim(),
    city:        document.getElementById('budget-city').value.trim(),
  };
  if (id) {
    try {
      const r = await fetch(`/api/budget/entries/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await r.json();
      const idx = _budget.entries.findIndex(x => x.id === id);
      if (idx !== -1) _budget.entries[idx] = updated;
      _closeExpenseModal();
      _renderBudget();
    } catch {
      alert(navigator.onLine ? t('modal.saveFailed') : t('offline.editBlocked'));
    }
    return;
  }
  try {
    const r = await fetch('/api/budget/entries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    _budget.entries.push(await r.json());
    if (typeof showToast === 'function') showToast(t('budget.expenseAdded'));
  } catch {
    _queuePendingEntry(payload);
  }
  _closeExpenseModal();
  _renderBudget();
});

document.getElementById('budget-delete-btn').addEventListener('click', async () => {
  const id = document.getElementById('budget-entry-id').value;
  if (!id || !confirm(t('budget.entry.confirmDelete'))) return;
  try {
    await fetch(`/api/budget/entries/${id}`, { method: 'DELETE' });
    _budget.entries = _budget.entries.filter(x => x.id !== id);
    _closeExpenseModal();
    _renderBudget();
  } catch {
    alert(navigator.onLine ? t('modal.deleteFailed') : t('offline.editBlocked'));
  }
});

document.getElementById('budget-settings-close').addEventListener('click', _closeSettingsModal);
document.getElementById('budget-settings-cancel').addEventListener('click', _closeSettingsModal);
wireModal(document.getElementById('budget-settings-overlay'), _closeSettingsModal);

document.getElementById('btn-add-category').addEventListener('click', () => {
  const used = [...document.querySelectorAll('#settings-categories .category-edit-row')].map(r => r.dataset.color);
  const next = CATEGORY_SWATCHES.find(c => !used.includes(c)) || CATEGORY_SWATCHES[0];
  _addCategoryRow('c' + Date.now() + '_' + (_catRowSeq++), '', next);
});

document.getElementById('settings-categories').addEventListener('click', e => {
  const rm = e.target.closest('.subbudget-remove');
  if (rm) { rm.closest('.category-edit-row').remove(); return; }
  const sw = e.target.closest('.cat-swatch');
  if (sw) {
    const row = sw.closest('.category-edit-row');
    row.dataset.color = sw.dataset.color;
    row.querySelectorAll('.cat-swatch').forEach(s => s.classList.toggle('selected', s === sw));
  }
});

document.getElementById('btn-add-subbudget').addEventListener('click', () => {
  const used = [...document.querySelectorAll('#settings-subbudgets .subbudget-cat')].map(s => s.value);
  const next = BUDGET_CATEGORIES.find(c => !used.includes(c)) || 'other';
  _addSubBudgetRow(next, null);
});

document.getElementById('settings-subbudgets').addEventListener('click', e => {
  const btn = e.target.closest('.subbudget-remove');
  if (btn) btn.closest('.subbudget-edit-row').remove();
});

document.getElementById('budget-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const categories = [];
  for (const row of document.querySelectorAll('#settings-categories .category-edit-row')) {
    const name = row.querySelector('.category-name').value.trim();
    if (name) categories.push({ id: row.dataset.id, name, color: row.dataset.color });
  }
  const byCat = {};
  for (const row of document.querySelectorAll('#settings-subbudgets .subbudget-edit-row')) {
    const category = row.querySelector('.subbudget-cat').value;
    const amount   = parseFloat(row.querySelector('.subbudget-amt').value);
    if (amount > 0) byCat[category] = { category, amount };
  }
  const subBudgets = Object.values(byCat);
  const payload = {
    initialBudget:         parseFloat(document.getElementById('settings-initial-budget').value),
    initialBudgetCurrency: document.getElementById('settings-currency').value,
    subBudgets,
    categories,
  };
  try {
    const r = await fetch('/api/budget/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    _budget = { ..._budget, ...(await r.json()) };
    _closeSettingsModal();
    _renderBudget();
  } catch { alert(t('modal.saveFailed')); }
});

function _currenciesInUse() {
  const set = new Set(['USD', 'EUR', 'CHF', 'ARS']);
  set.add(_budget.initialBudgetCurrency || 'EUR');
  for (const e of _budget.entries) if (e.currency) set.add(e.currency);
  if (typeof getWishlistCurrencies === 'function') {
    for (const c of getWishlistCurrencies()) if (c) set.add(c);
  }
  return [...set].sort();
}

function _renderRatesAdvanced() {
  const fetchedAt = getRatesFetchedAt();
  document.getElementById('budget-rates-fetched').textContent = t('budget.advanced.lastFetched', {
    when: fetchedAt ? new Date(fetchedAt).toLocaleString(getDateLocale()) : t('budget.advanced.never'),
  });

  const el = document.getElementById('budget-rates-list');
  el.innerHTML = _currenciesInUse().map(code => {
    if (code === 'USD') return '';
    const info = getRateInfo(code);
    return `
      <div class="rate-edit-row" data-currency="${code}">
        <span class="rate-edit-code">${code}</span>
        <span class="rate-edit-fetched">${info.fetched !== null ? info.fetched.toFixed(4) : '—'} (${t('budget.advanced.fetchedLabel')})</span>
        <input type="number" step="0.0001" class="rate-edit-override" placeholder="${t('budget.advanced.fetchedLabel')}" value="${info.override !== null ? info.override : ''}" />
        <button type="button" class="subbudget-remove rate-edit-clear" aria-label="${t('budget.advanced.clear')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
  }).join('');
}

document.getElementById('budget-rates-list').addEventListener('change', async e => {
  const input = e.target.closest('.rate-edit-override');
  if (!input) return;
  const currency = input.closest('.rate-edit-row').dataset.currency;
  await fetch('/api/rates/overrides', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency, value: input.value === '' ? null : parseFloat(input.value) }),
  });
  await refreshCurrency();
  _renderRatesAdvanced();
  _renderBudget();
});

document.getElementById('budget-rates-list').addEventListener('click', async e => {
  const btn = e.target.closest('.rate-edit-clear');
  if (!btn) return;
  const currency = btn.closest('.rate-edit-row').dataset.currency;
  await fetch('/api/rates/overrides', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency, value: null }),
  });
  await refreshCurrency();
  _renderRatesAdvanced();
  _renderBudget();
});

document.getElementById('budget-rates-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('budget-rates-refresh');
  btn.disabled = true;
  btn.textContent = t('budget.advanced.refreshing');
  await fetch('/api/rates/refresh', { method: 'POST' });
  await refreshCurrency();
  _renderRatesAdvanced();
  _renderBudget();
  btn.disabled = false;
  btn.textContent = t('budget.advanced.refresh');
});

document.addEventListener('langchange', () => {
  if (_budget) _renderBudget();
});

function getBudgetRemaining() {
  if (!_budget?.initialBudget) return null;
  return _computeStats().remaining;
}

function getBudgetCurrency() {
  return _budget?.initialBudgetCurrency || 'EUR';
}

// Data for the Today view's budget line (null until budget is loaded/configured)
function getTodayBudget() {
  if (!_budget?.initialBudget) return null;
  const s = _computeStats();
  const today = appToday();
  const spentToday = _budget.entries
    .filter(e => e.date === today)
    .reduce((sum, e) => sum + toUSD(e.amount, e.currency, e.rate), 0);
  return {
    spent: formatCurrency(spentToday),
    dailyLeft: s.dailyBudgetLeft !== null ? formatCurrency(s.dailyBudgetLeft) : null,
  };
}
