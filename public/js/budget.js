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

let _budget = null;
let _budgetTrip = null;

async function initBudget(tripData) {
  _budgetTrip = tripData;
  const res = await fetch('/api/budget');
  _budget = await res.json();
  _renderBudget();
}

// ── Helpers ────────────────────────────────────

function _fmt(amount) {
  const currency = _budget.currency || 'EUR';
  try {
    return new Intl.NumberFormat(getDateLocale(), {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return currency + ' ' + Math.round(amount).toLocaleString();
  }
}

function _computeStats() {
  const { initialBudget, entries } = _budget;
  const trip = _budgetTrip.trip;
  const today = toDateStr(new Date());

  const totalSpent = entries.reduce((s, e) => s + e.amount, 0);
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
  if (!_budgetTrip?.accommodations) return '';
  const stay = _budgetTrip.accommodations.find(a => a.check_in <= dateStr && a.check_out > dateStr);
  return stay ? stay.city : '';
}

// ── Render ─────────────────────────────────────

function _renderBudget() {
  _renderStats();
  _renderCategories();
  _renderEntries();
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
  const projClass = s.projectedRemaining === null ? '' : s.projectedRemaining >= 0 ? 'positive' : 'negative';
  const barColor  = s.pctSpent < 75 ? 'var(--c-stay)' : s.pctSpent < 100 ? 'var(--accent)' : 'var(--c-flight--neg, #e87a7a)';

  el.innerHTML = `
    <div class="budget-stats-main">
      <div class="budget-stat-card">
        <span class="budget-stat-label">${t('budget.stats.budget')}</span>
        <span class="budget-stat-val">${_fmt(s.initialBudget)}</span>
      </div>
      <div class="budget-stat-card">
        <span class="budget-stat-label">${t('budget.stats.spent')}</span>
        <span class="budget-stat-val">${_fmt(s.totalSpent)}</span>
      </div>
      <div class="budget-stat-card">
        <span class="budget-stat-label">${t('budget.stats.remaining')}</span>
        <span class="budget-stat-val budget-val--${remClass}">${_fmt(s.remaining)}</span>
      </div>
      <div class="budget-stat-card">
        <span class="budget-stat-label">${t('budget.stats.projected')}</span>
        <span class="budget-stat-val${projClass ? ' budget-val--' + projClass : ''}">${s.projectedTotal > 0 ? _fmt(s.projectedTotal) : '—'}</span>
      </div>
    </div>

    <div class="budget-progress-track">
      <div class="budget-progress-fill" style="width:${s.pctSpent.toFixed(1)}%; background:${barColor}"></div>
    </div>

    <div class="budget-stats-secondary">
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.dailyAvg')}</span>
        <span class="budget-sec-val">${s.dailyAvg > 0 ? _fmt(s.dailyAvg) : '—'}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.weeklyAvg')}</span>
        <span class="budget-sec-val">${s.weeklyAvg > 0 ? _fmt(s.weeklyAvg) : '—'}</span>
      </div>
      <div class="budget-sec-item">
        <span class="budget-sec-label">${t('budget.stats.dailyLeft')}</span>
        <span class="budget-sec-val${s.dailyBudgetLeft !== null && s.dailyBudgetLeft < 0 ? ' budget-val--negative' : ''}">${s.dailyBudgetLeft !== null ? _fmt(s.dailyBudgetLeft) : '—'}</span>
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
        <span class="budget-sec-val budget-val--${projClass}">${_fmt(s.projectedRemaining)}</span>
      </div>` : ''}
    </div>
  `;
}

function _renderCategories() {
  const el = document.getElementById('budget-categories-bar');
  if (!el) return;

  const { entries } = _budget;
  if (!entries.length || !_budget.initialBudget) { el.innerHTML = ''; return; }

  const totals = {};
  let grandTotal = 0;
  for (const e of entries) {
    totals[e.category] = (totals[e.category] || 0) + e.amount;
    grandTotal += e.amount;
  }

  const sorted = BUDGET_CATEGORIES.filter(c => totals[c]).sort((a, b) => totals[b] - totals[a]);
  if (!sorted.length) { el.innerHTML = ''; return; }

  const rows = sorted.map(cat => {
    const pct = ((totals[cat] / grandTotal) * 100).toFixed(0);
    return `
      <div class="budget-cat-row">
        <span class="budget-cat-dot" style="background:${BUDGET_CAT_COLORS[cat]}"></span>
        <span class="budget-cat-name">${t('budget.cat.' + cat)}</span>
        <div class="budget-cat-track">
          <div class="budget-cat-fill" style="width:${pct}%; background:${BUDGET_CAT_COLORS[cat]}"></div>
        </div>
        <span class="budget-cat-amt">${_fmt(totals[cat])}</span>
        <span class="budget-cat-pct">${pct}%</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-block">
      <h3 class="budget-sub-title">${t('budget.categories.title')}</h3>
      ${rows}
    </div>`;
}

function _renderEntries() {
  const el = document.getElementById('budget-entries-list');
  if (!el) return;

  const { entries } = _budget;
  if (!entries.length) {
    el.innerHTML = `<p class="budget-empty">${t('budget.entries.empty')}</p>`;
    return;
  }

  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  const grouped = {};
  for (const e of sorted) {
    if (!grouped[e.date]) grouped[e.date] = [];
    grouped[e.date].push(e);
  }

  const rows = Object.entries(grouped).map(([date, dayEntries]) => {
    const dayTotal = dayEntries.reduce((s, e) => s + e.amount, 0);
    const dow = parseLocal(date).toLocaleDateString(getDateLocale(), { weekday: 'short' });
    const dateLabel = `${dow}, ${fmtDate(date)}`;
    const eRows = dayEntries.map(e => `
      <div class="budget-entry" data-id="${e.id}">
        <span class="budget-entry-dot" style="background:${BUDGET_CAT_COLORS[e.category] || '#9a9080'}"></span>
        <div class="budget-entry-info">
          <span class="budget-entry-desc">${e.description || t('budget.cat.' + e.category)}</span>
          ${e.city ? `<span class="budget-entry-city">${e.city}</span>` : ''}
        </div>
        <span class="budget-entry-amount">${_fmt(e.amount)}</span>
      </div>`).join('');

    return `
      <div class="budget-day-group">
        <div class="budget-day-header">
          <span class="budget-day-label">${dateLabel}</span>
          <span class="budget-day-total">${_fmt(dayTotal)}</span>
        </div>
        ${eRows}
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-block">
      <h3 class="budget-sub-title">${t('budget.entries.title')}</h3>
      ${rows}
    </div>`;

  el.querySelectorAll('.budget-entry').forEach(row => {
    row.addEventListener('click', () => _openExpenseModal(row.dataset.id));
  });
}

// ── Expense modal ──────────────────────────────

function _getSelectedCat() {
  return document.querySelector('#budget-cat-selector .type-btn.active')?.dataset.cat || 'other';
}

function _setSelectedCat(cat) {
  document.querySelectorAll('#budget-cat-selector .type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
}

function _openExpenseModal(id) {
  const overlay  = document.getElementById('budget-overlay');
  const titleEl  = document.getElementById('budget-modal-title');
  const deleteBtn = document.getElementById('budget-delete-btn');

  document.getElementById('budget-form').reset();
  document.getElementById('budget-entry-id').value = '';

  if (id) {
    const entry = _budget.entries.find(e => e.id === id);
    if (!entry) return;
    titleEl.textContent = t('budget.entry.edit');
    document.getElementById('budget-entry-id').value  = id;
    document.getElementById('budget-date').value       = entry.date;
    document.getElementById('budget-amount').value     = entry.amount;
    document.getElementById('budget-description').value = entry.description || '';
    document.getElementById('budget-city').value       = entry.city || '';
    _setSelectedCat(entry.category);
    deleteBtn.hidden = false;
  } else {
    titleEl.textContent = t('budget.entry.add');
    const today = toDateStr(new Date());
    document.getElementById('budget-date').value = today;
    document.getElementById('budget-city').value = _cityForDate(today);
    _setSelectedCat('food');
    deleteBtn.hidden = true;
  }

  overlay.hidden = false;
  setTimeout(() => document.getElementById('budget-amount').focus(), 50);
}

function _closeExpenseModal() {
  document.getElementById('budget-overlay').hidden = true;
}

// ── Settings modal ─────────────────────────────

function _openSettingsModal() {
  document.getElementById('settings-initial-budget').value = _budget.initialBudget || '';
  document.getElementById('settings-currency').value = _budget.currency || 'EUR';
  document.getElementById('budget-settings-overlay').hidden = false;
}

function _closeSettingsModal() {
  document.getElementById('budget-settings-overlay').hidden = true;
}

// ── Event wiring ───────────────────────────────

document.getElementById('btn-add-expense').addEventListener('click', () => _openExpenseModal(null));
document.getElementById('btn-budget-settings').addEventListener('click', _openSettingsModal);

document.getElementById('budget-modal-close').addEventListener('click', _closeExpenseModal);
document.getElementById('budget-cancel-btn').addEventListener('click', _closeExpenseModal);
document.getElementById('budget-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('budget-overlay')) _closeExpenseModal();
});

document.getElementById('budget-cat-selector').addEventListener('click', e => {
  const btn = e.target.closest('.type-btn');
  if (btn) _setSelectedCat(btn.dataset.cat);
});

document.getElementById('budget-date').addEventListener('change', e => {
  const city = _cityForDate(e.target.value);
  if (city) document.getElementById('budget-city').value = city;
});

document.getElementById('budget-form').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('budget-entry-id').value;
  const payload = {
    date:        document.getElementById('budget-date').value,
    amount:      parseFloat(document.getElementById('budget-amount').value),
    category:    _getSelectedCat(),
    description: document.getElementById('budget-description').value.trim(),
    city:        document.getElementById('budget-city').value.trim(),
  };
  try {
    if (id) {
      const r = await fetch(`/api/budget/entries/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const updated = await r.json();
      const idx = _budget.entries.findIndex(x => x.id === id);
      if (idx !== -1) _budget.entries[idx] = updated;
    } else {
      const r = await fetch('/api/budget/entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      _budget.entries.push(await r.json());
    }
    _closeExpenseModal();
    _renderBudget();
  } catch { alert(t('modal.saveFailed')); }
});

document.getElementById('budget-delete-btn').addEventListener('click', async () => {
  const id = document.getElementById('budget-entry-id').value;
  if (!id || !confirm(t('budget.entry.confirmDelete'))) return;
  try {
    await fetch(`/api/budget/entries/${id}`, { method: 'DELETE' });
    _budget.entries = _budget.entries.filter(x => x.id !== id);
    _closeExpenseModal();
    _renderBudget();
  } catch { alert(t('modal.deleteFailed')); }
});

document.getElementById('budget-settings-close').addEventListener('click', _closeSettingsModal);
document.getElementById('budget-settings-cancel').addEventListener('click', _closeSettingsModal);
document.getElementById('budget-settings-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('budget-settings-overlay')) _closeSettingsModal();
});

document.getElementById('budget-settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    initialBudget: parseFloat(document.getElementById('settings-initial-budget').value),
    currency:      document.getElementById('settings-currency').value,
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

document.addEventListener('langchange', () => {
  if (_budget) _renderBudget();
});

function getBudgetRemaining() {
  if (!_budget?.initialBudget) return null;
  return _computeStats().remaining;
}

function getBudgetCurrency() {
  return _budget?.currency || 'EUR';
}

function refreshBudget() {
  if (_budget) _renderBudget();
}
