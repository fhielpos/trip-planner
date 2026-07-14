/* =============================================
   Budget Insights Page
   Read-only deeper-dive on top of the main page's Budget section: overall
   budget/spent/remaining context, a "right now" per-stay spending
   allowance, spend by city (with a per-category breakdown per city), and
   a cumulative-spend-vs-pace chart with an explicit budget cap and a
   projected-finish line.
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

let _biBudget = null;
let _biTrip = null;
let _biAccommodations = [];

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _biFmtMoney(amount) {
  const currency = _biBudget?.currency || 'EUR';
  try {
    return new Intl.NumberFormat(getDateLocale(), {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return currency + ' ' + Math.round(amount).toLocaleString();
  }
}

function _parseLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _nightsFor(stay) {
  return Math.round((_parseLocal(stay.check_out) - _parseLocal(stay.check_in)) / 86400000);
}

// Duplicated from app.js's getActiveStay — this page doesn't load app.js.
function _getActiveStay(dayStr) {
  return _biAccommodations.find(a => a.check_in <= dayStr && a.check_out > dayStr) || null;
}

function _biTotalSpent() {
  return (_biBudget.entries || []).reduce((s, e) => s + e.amount, 0);
}

// Duplicated from app.js's DEV_DATE/appToday — this page doesn't load app.js.
// Param name matched case-insensitively — browsers/mobile keyboards often
// auto-capitalize the first letter of a manually-typed query string.
const _BI_DEV_DATE = (() => {
  let v = null;
  for (const [k, val] of new URLSearchParams(location.search)) {
    if (k.toLowerCase() === 'today') { v = val; break; }
  }
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
})();

function _biToday() {
  if (_BI_DEV_DATE) return _BI_DEV_DATE;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Overall budget context ─────────────────────
// One hero card instead of two stacked boxes: leads with the "Remaining"
// figure (the actionable number) plus the same progress bar the main
// page's stats grid uses, Budget/Spent as smaller supporting figures, and
// the "right now" city allowance folded in as a small inline line (a
// stay-color dot, not a competing full-width border) rather than its own
// card fighting for attention.
function _renderHero() {
  const el = document.getElementById('bi-hero');
  const initialBudget = _biBudget.initialBudget;
  if (!initialBudget) {
    el.innerHTML = `<p class="budget-empty">${t('budgetInsights.noBudget')}</p>`;
    return;
  }

  const totalSpent = _biTotalSpent();
  const remaining = initialBudget - totalSpent;
  const pctSpent = Math.min(110, (totalSpent / initialBudget) * 100);
  const barColor = pctSpent < 75 ? 'var(--c-stay)' : pctSpent < 100 ? 'var(--accent)' : 'var(--c-danger)';

  // "Right now": how much of the remaining budget's daily share is left
  // for the stay you're currently in — same dailyBudgetLeft formula
  // budget.js's _computeStats uses, applied to just the current stay's
  // remaining nights instead of the whole trip's remaining days.
  let allowanceHtml = '';
  const today = _biToday();
  const stay = _getActiveStay(today);
  if (stay) {
    const tripStart = _parseLocal(_biTrip.trip.startDate);
    const tripEnd = _parseLocal(_biTrip.trip.endDate);
    const todayDate = _parseLocal(today);
    const daysRemaining = todayDate < tripStart
      ? _tripTotalDays()
      : Math.max(0, Math.round((tripEnd - todayDate) / 86400000));
    if (daysRemaining > 0) {
      const dailyBudgetLeft = remaining / daysRemaining;
      const nightsLeftInStay = Math.max(1, Math.round((_parseLocal(stay.check_out) - todayDate) / 86400000));
      const allowance = dailyBudgetLeft * nightsLeftInStay;
      allowanceHtml = `
        <div class="bi-hero-allowance">
          <span class="bi-hero-city-dot" style="background:${_escHtml(stay.color || 'var(--accent)')}"></span>
          <span class="bi-hero-allowance-text${allowance < 0 ? ' budget-val--negative' : ''}">${t('budgetInsights.cityAllowance', {
            amount: `<span class="accom-mono bi-hero-allowance-amt">${_biFmtMoney(allowance)}</span>`,
            city: _escHtml(stay.city),
          })}</span>
        </div>`;
    }
  }

  el.innerHTML = `
    <div class="bi-hero-card">
      <span class="bi-hero-label">${t('budget.stats.remaining')}</span>
      <span class="bi-hero-remaining accom-mono${remaining < 0 ? ' budget-val--negative' : ''}">${_biFmtMoney(remaining)}</span>
      <div class="budget-progress-track bi-hero-progress">
        <div class="budget-progress-fill" style="width:${pctSpent.toFixed(1)}%; background:${barColor}"></div>
      </div>
      <div class="bi-hero-sub">
        <div class="bi-hero-sub-item">
          <span class="bi-hero-sub-label">${t('budget.stats.budget')}</span>
          <span class="bi-hero-sub-val accom-mono">${_biFmtMoney(initialBudget)}</span>
        </div>
        <div class="bi-hero-sub-item">
          <span class="bi-hero-sub-label">${t('budget.stats.spent')}</span>
          <span class="bi-hero-sub-val accom-mono">${_biFmtMoney(totalSpent)}</span>
        </div>
      </div>
      ${allowanceHtml}
    </div>`;
}

// ── Section 1: spend by city ───────────────────

function _cityTotals(entries) {
  const totals = {};
  for (const e of entries) {
    const city = (e.city || '').trim();
    const key = city || '\0unassigned';
    if (!totals[key]) totals[key] = { city, amount: 0, count: 0, catTotals: {} };
    totals[key].amount += e.amount;
    totals[key].count += 1;
    totals[key].catTotals[e.category] = (totals[key].catTotals[e.category] || 0) + e.amount;
  }
  return Object.values(totals);
}

function _nightsByCity() {
  const nights = {};
  for (const a of _biAccommodations) {
    nights[a.city] = (nights[a.city] || 0) + _nightsFor(a);
  }
  return nights;
}

function _colorForCity(city) {
  return _biAccommodations.find(a => a.city === city)?.color || '';
}

// Duplicated from budget.js's BUDGET_CATEGORIES/BUDGET_CAT_COLORS/_catName/_catColor
// — this page doesn't load budget.js (see the file header comment).
const BI_BUDGET_CATEGORIES = ['food', 'transport', 'accommodation', 'activities', 'shopping', 'other'];
const BI_BUDGET_CAT_COLORS = {
  food:          '#d8b47a',
  transport:     '#8ec8de',
  accommodation: '#8ec8b0',
  activities:    '#bea8d8',
  shopping:      '#e8a0a0',
  other:         '#b0a898',
};

function _biCatName(id) {
  const c = (_biBudget.categories || []).find(c => c.id === id);
  if (c) return c.name;
  return BI_BUDGET_CATEGORIES.includes(id) ? t('budget.cat.' + id) : id;
}

function _biCatColor(id) {
  const c = (_biBudget.categories || []).find(c => c.id === id);
  if (c) return c.color;
  return BI_BUDGET_CAT_COLORS[id] || '#9a9080';
}

const _biExpandedCities = new Set();

function _renderCityList() {
  const el = document.getElementById('bi-city-list');
  const entries = _biBudget.entries || [];
  if (!entries.length) {
    el.innerHTML = `<p class="budget-empty">${t('budget.entries.empty')}</p>`;
    return;
  }

  const nightsByCity = _nightsByCity();
  const grandTotal = entries.reduce((s, e) => s + e.amount, 0);
  const rows = _cityTotals(entries).sort((a, b) => b.amount - a.amount);

  el.innerHTML = rows.map(row => {
    const isUnassigned = !row.city;
    const key = isUnassigned ? '\0unassigned' : row.city;
    const name = isUnassigned ? t('budgetInsights.unassigned') : row.city;
    const color = isUnassigned ? '' : _colorForCity(row.city);
    const nights = isUnassigned ? 0 : (nightsByCity[row.city] || 0);
    const perDay = nights > 0 ? row.amount / nights : null;
    const pct = grandTotal > 0 ? (row.amount / grandTotal) * 100 : 0;
    const entryLabel = t(row.count === 1 ? 'budgetInsights.entry' : 'budgetInsights.entries');
    const expanded = _biExpandedCities.has(key);

    const catRows = Object.entries(row.catTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `
        <div class="bi-cat-row">
          <span class="bi-cat-dot" style="background:${_biCatColor(cat)}"></span>
          <span class="bi-cat-name">${_escHtml(_biCatName(cat))}</span>
          <span class="bi-cat-amt accom-mono">${_biFmtMoney(amt)}</span>
        </div>`).join('');

    return `
      <div class="bi-city-item">
        <div class="bi-city-row" style="--stay-color:${_escHtml(color)}">
          <button type="button" class="bi-city-toggle${expanded ? ' is-expanded' : ''}" data-key="${_escHtml(key)}" aria-label="${t('budgetInsights.categoryBreakdown')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
          </button>
          <div class="bi-city-main">
            <span class="bi-city-name">${_escHtml(name)}</span>
            <span class="bi-city-count">${row.count} ${entryLabel}</span>
          </div>
          <div class="budget-cat-track bi-city-track">
            <div class="budget-cat-fill" style="width:${pct.toFixed(1)}%; background:${color || 'var(--accent)'}"></div>
          </div>
          <div class="bi-city-figure">
            <span class="accom-row-figure-label">${t('budgetInsights.total')}</span>
            <span class="accom-row-figure-val accom-mono">${_biFmtMoney(row.amount)}</span>
          </div>
          <div class="bi-city-figure">
            <span class="accom-row-figure-label">${t('budgetInsights.perDay')}</span>
            ${perDay !== null
              ? `<span class="accom-row-figure-val accom-row-figure-val--accent accom-mono">${_biFmtMoney(perDay)}</span>`
              : `<span class="accom-row-figure-val accom-no-price">—</span>`}
          </div>
        </div>
        <div class="bi-city-breakdown"${expanded ? '' : ' hidden'} data-key="${_escHtml(key)}">${catRows}</div>
      </div>`;
  }).join('');

  el.querySelectorAll('.bi-city-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const panel = el.querySelector(`.bi-city-breakdown[data-key="${CSS.escape(key)}"]`);
      const nowExpanded = panel.hidden;
      panel.hidden = !nowExpanded;
      btn.classList.toggle('is-expanded', nowExpanded);
      if (nowExpanded) _biExpandedCities.add(key); else _biExpandedCities.delete(key);
    });
  });
}

// ── Section 2: spend trend (cumulative vs. even pace) ─────────────────

function _tripTotalDays() {
  const { startDate, endDate } = _biTrip.trip;
  return Math.round((_parseLocal(endDate) - _parseLocal(startDate)) / 86400000) + 1;
}

function _dayIndexForDate(dateStr) {
  const start = _parseLocal(_biTrip.trip.startDate);
  return Math.round((_parseLocal(dateStr) - start) / 86400000) + 1;
}

function _renderTrend() {
  const el = document.getElementById('bi-trend');
  const initialBudget = _biBudget.initialBudget;
  if (!initialBudget) {
    el.innerHTML = `<p class="budget-empty">${t('budgetInsights.noBudget')}</p>`;
    return;
  }

  const totalDays = _tripTotalDays();
  const today = _biToday();
  const todayIdx = Math.min(totalDays, Math.max(1, _dayIndexForDate(today)));

  const sorted = [...(_biBudget.entries || [])].sort((a, b) => a.date.localeCompare(b.date));
  const actualPoints = [{ day: 1, amt: 0 }];
  let running = 0;
  for (const e of sorted) {
    const day = Math.min(totalDays, Math.max(1, _dayIndexForDate(e.date)));
    running += e.amount;
    actualPoints.push({ day, amt: running });
  }
  if (actualPoints[actualPoints.length - 1].day < todayIdx) {
    actualPoints.push({ day: todayIdx, amt: running });
  }

  // Same daysElapsed/projectedTotal formula as budget.js's _computeStats,
  // duplicated here — this page doesn't load budget.js.
  const tripStart = _parseLocal(_biTrip.trip.startDate);
  const tripEnd = _parseLocal(_biTrip.trip.endDate);
  const todayDate = _parseLocal(today);
  const cappedToday = todayDate < tripStart ? tripStart : todayDate > tripEnd ? tripEnd : todayDate;
  const daysElapsed = Math.max(1, Math.round((cappedToday - tripStart) / 86400000) + 1);
  const dailyAvg = running > 0 ? running / daysElapsed : 0;
  const projectedTotal = dailyAvg > 0 ? dailyAvg * totalDays : 0;
  const showProjection = projectedTotal > 0 && todayIdx < totalDays;

  // Cap how far a runaway projection can stretch the chart's scale — past
  // 2x budget it stops adding useful detail and just crushes the actual/
  // pace lines into a sliver at the bottom. The projection line itself is
  // clamped to the same ceiling, with a marker showing it's a floor, not
  // the literal projected figure (which is still in its tooltip/aria text).
  const paceMax = initialBudget;
  const projectionCap = initialBudget * 2;
  const projectionCapped = projectedTotal > projectionCap;
  const projectedForChart = Math.min(projectedTotal, projectionCap);
  const maxAmt = Math.max(paceMax, running, projectedForChart, 1);

  const W = 640, H = 220, PAD_X = 8, PAD_TOP = 16, PAD_BOTTOM = 32;
  const xFor = day => totalDays > 1
    ? PAD_X + ((day - 1) / (totalDays - 1)) * (W - 2 * PAD_X)
    : W / 2;
  const yFor = amt => H - PAD_BOTTOM - (amt / maxAmt) * (H - PAD_TOP - PAD_BOTTOM);

  const actualPath = actualPoints.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xFor(p.day).toFixed(1)},${yFor(p.amt).toFixed(1)}`
  ).join(' ');
  const pacePath = `M${xFor(1).toFixed(1)},${yFor(0).toFixed(1)} L${xFor(totalDays).toFixed(1)},${yFor(paceMax).toFixed(1)}`;
  const capY = yFor(initialBudget);
  const capPath = `M${xFor(1).toFixed(1)},${capY.toFixed(1)} L${xFor(totalDays).toFixed(1)},${capY.toFixed(1)}`;
  const projectionEndX = xFor(totalDays);
  const projectionEndY = yFor(projectedForChart);
  const projectionPath = showProjection
    ? `M${xFor(todayIdx).toFixed(1)},${yFor(running).toFixed(1)} L${projectionEndX.toFixed(1)},${projectionEndY.toFixed(1)}`
    : '';

  const last = actualPoints[actualPoints.length - 1];
  const pinX = xFor(last.day);
  const pinY = yFor(last.amt);

  const axisY = H - PAD_BOTTOM + 16;
  const startLabel = fmtDate(_biTrip.trip.startDate, { year: false });
  const endLabel = fmtDate(_biTrip.trip.endDate, { year: false });
  const capLabel = `${t('budget.stats.budget')}: ${_biFmtMoney(initialBudget)}`;

  // Danger zone: the region above the budget cap, shaded faintly — turns
  // what would otherwise be dead empty space (the chart's scale has to
  // fit the cap even when actual spend is still low) into the one thing
  // a pacing chart should say at a glance: are you in overspend territory.
  const dangerZoneHeight = Math.max(0, capY - PAD_TOP);

  el.innerHTML = `
    <svg class="bi-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${t('budgetInsights.trendTitle')}">
      ${dangerZoneHeight > 0.5 ? `<rect x="${PAD_X}" y="${PAD_TOP}" width="${W - 2 * PAD_X}" height="${dangerZoneHeight.toFixed(1)}" class="bi-trend-danger-zone" />` : ''}
      <path d="${capPath}" class="bi-trend-cap" fill="none" />
      <path d="${pacePath}" class="bi-trend-pace" fill="none" />
      ${showProjection ? `<path d="${projectionPath}" class="bi-trend-projection" fill="none" />` : ''}
      ${showProjection && projectionCapped ? `<text x="${projectionEndX.toFixed(1)}" y="${(projectionEndY - 5).toFixed(1)}" class="bi-trend-projection-capped" text-anchor="middle">▲<title>${_escHtml(_biFmtMoney(projectedTotal))}</title></text>` : ''}
      <path d="${actualPath}" class="bi-trend-actual" fill="none" />
      <text x="${xFor(1)}" y="${(capY - 6).toFixed(1)}" class="bi-trend-cap-label" text-anchor="start">${_escHtml(capLabel)}</text>
      <text x="${pinX}" y="${(pinY - 10).toFixed(1)}" class="bi-trend-pin" text-anchor="middle">📍</text>
      <text x="${xFor(1)}" y="${axisY}" class="bi-trend-axis-label" text-anchor="start">${_escHtml(startLabel)}</text>
      <text x="${xFor(todayIdx)}" y="${axisY}" class="bi-trend-axis-label" text-anchor="middle">${t('budgetInsights.axisToday')}</text>
      <text x="${xFor(totalDays)}" y="${axisY}" class="bi-trend-axis-label" text-anchor="end">${_escHtml(endLabel)}</text>
    </svg>
    <div class="bi-trend-legend">
      <span class="bi-legend-item"><span class="bi-legend-swatch bi-legend-swatch--actual"></span>${t('budgetInsights.legendActual')}</span>
      <span class="bi-legend-item"><span class="bi-legend-swatch bi-legend-swatch--pace"></span>${t('budgetInsights.legendPace')}</span>
      ${showProjection ? `<span class="bi-legend-item"><span class="bi-legend-swatch bi-legend-swatch--projection"></span>${t('budgetInsights.legendProjected')}</span>` : ''}
    </div>`;
}

// ── Init ────────────────────────────────────────

function _renderAll() {
  _renderHero();
  _renderCityList();
  _renderTrend();
}

document.addEventListener('langchange', () => {
  if (_biBudget) _renderAll();
});

async function _init() {
  await initI18n();
  const [budgetRes, tripRes, accomRes] = await Promise.all([
    fetch('/api/budget'),
    fetch('/api/trip'),
    fetch('/api/accommodations'),
  ]);
  _biBudget = await budgetRes.json();
  _biTrip = await tripRes.json();
  _biAccommodations = await accomRes.json();
  _renderAll();
}

_init();
