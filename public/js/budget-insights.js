/* =============================================
   Budget Insights Page
   Read-only deeper-dive on top of the main page's Budget section: a
   pace card (spend-per-day vs. the budget's daily plan, projected
   total, and the date the budget runs out), a category breakdown, a
   by-country breakdown, and a caveated callout for the standout finding.
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

let _biBudget = null;
let _biTrip = null;
let _biAccommodations = [];

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _parseLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _isoLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Duplicated from app.js's getActiveStay — this page doesn't load app.js.
function _getActiveStay(dayStr) {
  return _biAccommodations.find(a => a.check_in <= dayStr && a.check_out > dayStr) || null;
}

function _biTotalSpent() {
  return (_biBudget.entries || []).reduce((s, e) => s + toUSD(e.amount, e.currency, e.rate), 0);
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

function _tripTotalDays() {
  const { startDate, endDate } = _biTrip.trip;
  return Math.round((_parseLocal(endDate) - _parseLocal(startDate)) / 86400000) + 1;
}

function _dayIndexForDate(dateStr) {
  const start = _parseLocal(_biTrip.trip.startDate);
  return Math.round((_parseLocal(dateStr) - start) / 86400000) + 1;
}

// ── Category names / colours ───────────────────
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

// Built-in categories map onto the redesign's category tokens; custom
// categories keep their own stored colour.
const BI_CAT_TOKEN = {
  food:      '--cat-food',
  shopping:  '--cat-shopping',
  transport: '--cat-transport',
  activities: '--cat-culture',
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

function _biCatSwatch(id) {
  return BI_CAT_TOKEN[id] ? `var(${BI_CAT_TOKEN[id]})` : _biCatColor(id);
}

// ── Country names / flags ──────────────────────
// Place names, not translatable UI strings: a small map gives the Spanish
// exonym + flag; anything unlisted falls back to the raw (English) name.
const BI_COUNTRY = {
  Argentina:        { es: 'Argentina',      flag: '🇦🇷' },
  France:           { es: 'Francia',        flag: '🇫🇷' },
  Greece:           { es: 'Grecia',         flag: '🇬🇷' },
  Austria:          { es: 'Austria',        flag: '🇦🇹' },
  Germany:          { es: 'Alemania',       flag: '🇩🇪' },
  Switzerland:      { es: 'Suiza',          flag: '🇨🇭' },
  Netherlands:      { es: 'Países Bajos',   flag: '🇳🇱' },
  Belgium:          { es: 'Bélgica',        flag: '🇧🇪' },
  Italy:            { es: 'Italia',         flag: '🇮🇹' },
  Spain:            { es: 'España',         flag: '🇪🇸' },
  Portugal:         { es: 'Portugal',       flag: '🇵🇹' },
  'United Kingdom': { es: 'Reino Unido',    flag: '🇬🇧' },
  'Czech Republic': { es: 'República Checa', flag: '🇨🇿' },
};

function _biCountryName(c) {
  const e = BI_COUNTRY[c];
  return e && getDateLocale() === 'es-ES' ? e.es : c;
}

function _biCountryFlag(c) {
  return (BI_COUNTRY[c] && BI_COUNTRY[c].flag) || '🏳️';
}

function _cityCountryMap() {
  const m = {};
  for (const a of _biAccommodations) {
    if (a.city && a.country) m[a.city.trim().toLowerCase()] = a.country;
  }
  return m;
}

// Distinct nights per country (a night is keyed by the date you sleep it),
// plus the trip's distinct-night total — dedupes any overlapping bookings.
function _nightSetByCountry() {
  const map = {};
  const all = new Set();
  for (const a of _biAccommodations) {
    if (!a.country) continue;
    let d = _parseLocal(a.check_in);
    const end = _parseLocal(a.check_out);
    while (d < end) {
      const k = _isoLocal(d);
      (map[a.country] = map[a.country] || new Set()).add(k);
      all.add(k);
      d = new Date(d.getTime() + 86400000);
    }
  }
  return { map, total: all.size };
}

// ── Context line ───────────────────────────────

function _renderContext() {
  const el = document.getElementById('bi-context');
  if (!el) return;
  const total = _tripTotalDays();
  const day = Math.min(total, Math.max(1, _dayIndexForDate(_biToday())));
  el.textContent = `${t('budget.stats.dayOf', { day, total })} · ${t('budgetInsights.meta.loaded', { amount: formatCurrency(_biTotalSpent()) })}`;
}

// ── Pace card ──────────────────────────────────
// Every figure derives from one basis: the plan is budget ÷ trip days
// (NOT the go-forward daily allowance on Today/Budget), pace is spend ÷
// days elapsed, projection is pace × trip days, and the crossover date
// is remaining ÷ pace days from today.
function _paceStats() {
  const budget = toUSD(_biBudget.initialBudget, _biBudget.initialBudgetCurrency);
  const totalDays = _tripTotalDays();
  const totalSpent = _biTotalSpent();
  const tripStart = _parseLocal(_biTrip.trip.startDate);
  const tripEnd = _parseLocal(_biTrip.trip.endDate);
  const todayDate = _parseLocal(_biToday());
  const cappedToday = todayDate < tripStart ? tripStart : todayDate > tripEnd ? tripEnd : todayDate;
  const daysElapsed = Math.max(1, Math.round((cappedToday - tripStart) / 86400000) + 1);

  const plan = totalDays > 0 ? budget / totalDays : 0;
  const pace = totalSpent / daysElapsed;
  const pacePct = plan > 0 ? (pace / plan) * 100 : 0;
  const projection = pace * totalDays;
  const remaining = budget - totalSpent;

  let crossoverIso = null;
  let crossoverCity = null;
  let crossoverBeyondTrip = false;
  if (pace > 0 && remaining > 0) {
    const days = remaining / pace;
    const cross = new Date(todayDate.getTime() + Math.round(days) * 86400000);
    crossoverIso = _isoLocal(cross);
    crossoverBeyondTrip = cross > tripEnd;
    const stay = _getActiveStay(crossoverIso);
    crossoverCity = stay ? stay.city : null;
  }

  return {
    budget, totalDays, totalSpent, daysElapsed,
    plan, pace, pacePct, projection, remaining,
    crossoverIso, crossoverCity, crossoverBeyondTrip,
  };
}

function _renderPace() {
  const el = document.getElementById('bi-pace');
  const s = _paceStats();
  if (!s.budget) {
    el.innerHTML = `<p class="budget-empty">${t('budgetInsights.noBudget')}</p>`;
    return;
  }

  const over = s.pacePct > 100;
  const figColor = over ? 'var(--warning)' : 'var(--positive)';
  const fillPct = Math.max(0, Math.min(100, s.pacePct / 2)); // 0–200% scale, plan tick at 50%
  const pctLabel = Math.round(s.pacePct);

  const dateSpan = s.crossoverIso
    ? `<span class="mono bi-pace-date">${fmtDate(s.crossoverIso, { year: false })}</span>`
    : '';
  let consequence;
  if (s.remaining <= 0) {
    consequence = t('budgetInsights.pace.exhausted');
  } else if (!s.crossoverIso || s.crossoverBeyondTrip) {
    consequence = t('budgetInsights.pace.crossoverSafe');
  } else if (s.crossoverCity) {
    consequence = t('budgetInsights.pace.crossover', { date: dateSpan, city: _escHtml(s.crossoverCity) });
  } else {
    consequence = t('budgetInsights.pace.crossoverNoCity', { date: dateSpan });
  }

  el.innerHTML = `
    <div class="bi-pace-card">
      <span class="label bi-pace-label">${t('budgetInsights.pace.label')}</span>
      <div class="bi-pace-headline">
        <span class="mono bi-pace-figure" style="color:${figColor}">${formatCurrency(s.pace)}</span>
        <span class="bi-pace-sub">${t('budgetInsights.pace.perDayPlan', { pct: pctLabel })}</span>
      </div>
      <div class="bi-pace-bar">
        <div class="bi-pace-bar-fill" style="width:${fillPct.toFixed(1)}%; background:${figColor}"></div>
        <div class="bi-pace-bar-tick"></div>
      </div>
      <div class="mono bi-pace-row">
        <span>${t('budgetInsights.pace.planPerDay', { amount: formatCurrency(s.plan) })}</span>
        <span>${t('budgetInsights.pace.projection', { amount: formatCurrency(s.projection) })}</span>
      </div>
      <p class="bi-pace-consequence">${consequence}</p>
      <p class="mono bi-pace-deriv">${t('budgetInsights.pace.derivation', {
        spent: formatCurrency(s.totalSpent),
        days: s.daysElapsed,
        plan: formatCurrency(s.budget),
        total: s.totalDays,
      })}</p>
    </div>`;
}

// ── By category ────────────────────────────────

function _renderCategories() {
  const el = document.getElementById('bi-categories');
  const entries = _biBudget.entries || [];
  if (!entries.length) {
    el.innerHTML = `<p class="budget-empty">${t('budget.entries.empty')}</p>`;
    return;
  }

  const totals = {};
  for (const e of entries) {
    totals[e.category] = (totals[e.category] || 0) + toUSD(e.amount, e.currency, e.rate);
  }
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const grand = rows.reduce((sum, [, v]) => sum + v, 0);

  const bar = rows.map(([cat, amt]) =>
    `<div class="bi-stack-seg" style="flex:${Math.max(1, Math.round(amt))}; background:${_biCatSwatch(cat)}"></div>`
  ).join('');

  const list = rows.map(([cat, amt]) => `
    <div class="bi-brk-row">
      <span class="bi-brk-dot" style="background:${_biCatSwatch(cat)}"></span>
      <span class="bi-brk-name">${_escHtml(_biCatName(cat))}</span>
      <span class="mono bi-brk-pct">${grand > 0 ? Math.round((amt / grand) * 100) : 0}%</span>
      <span class="mono bi-brk-amt">${formatCurrency(amt)}</span>
    </div>`).join('');

  el.innerHTML = `<div class="bi-stack">${bar}</div><div class="bi-brk-list">${list}</div>`;
}

// ── By country ─────────────────────────────────

function _renderCountries() {
  const el = document.getElementById('bi-countries');
  const caveatEl = document.getElementById('bi-country-caveat');
  const entries = _biBudget.entries || [];
  const cc = _cityCountryMap();
  const today = _biToday();

  const totals = {};
  let anyFuture = false;
  for (const e of entries) {
    const usd = toUSD(e.amount, e.currency, e.rate);
    const key = cc[(e.city || '').trim().toLowerCase()] || '\0unknown';
    if (!totals[key]) totals[key] = { amount: 0 };
    totals[key].amount += usd;
    if (e.date > today) anyFuture = true;
  }
  if (caveatEl) caveatEl.hidden = !anyFuture;

  const rows = Object.entries(totals).sort((a, b) => b[1].amount - a[1].amount);
  if (!rows.length) {
    el.innerHTML = `<p class="budget-empty">${t('budget.entries.empty')}</p>`;
    return;
  }
  const max = rows[0][1].amount || 1;

  el.innerHTML = rows.map(([key, v]) => {
    const known = key !== '\0unknown';
    const name = known ? _biCountryName(key) : t('budgetInsights.unassigned');
    const flag = known ? _biCountryFlag(key) : '🏳️';
    return `
      <div class="bi-country-row">
        <span class="bi-country-flag" role="img" aria-label="${_escHtml(name)}">${flag}</span>
        <span class="bi-country-bar"><span class="bi-country-bar-fill" style="width:${((v.amount / max) * 100).toFixed(1)}%"></span></span>
        <span class="mono bi-country-amt">${formatCurrency(v.amount)}</span>
      </div>`;
  }).join('');
}

// ── Callout — the standout finding, stated with its caveat ──────────────

function _renderCallout() {
  const el = document.getElementById('bi-callout');
  const entries = _biBudget.entries || [];
  const cc = _cityCountryMap();
  const today = _biToday();
  if (!entries.length) { el.innerHTML = ''; return; }

  const byCountry = {};
  let grand = 0;
  for (const e of entries) {
    const usd = toUSD(e.amount, e.currency, e.rate);
    grand += usd;
    const country = cc[(e.city || '').trim().toLowerCase()];
    if (!country) continue;
    if (!byCountry[country]) byCountry[country] = { amount: 0, future: 0, futureDates: [] };
    byCountry[country].amount += usd;
    if (e.date > today) {
      byCountry[country].future += usd;
      byCountry[country].futureDates.push(e.date);
    }
  }

  const top = Object.entries(byCountry).sort((a, b) => b[1].amount - a[1].amount)[0];
  if (!top || grand <= 0) { el.innerHTML = ''; return; }

  const [country, v] = top;
  const pct = Math.round((v.amount / grand) * 100);
  const { map: nightMap, total: totalNights } = _nightSetByCountry();
  const nights = (nightMap[country] && nightMap[country].size) || 0;

  let future = '';
  if (v.future > 0 && v.futureDates.length) {
    const sorted = [...v.futureDates].sort();
    const range = sorted[0] === sorted[sorted.length - 1]
      ? fmtDate(sorted[0], { year: false })
      : `${fmtDate(sorted[0], { year: false })}–${fmtDate(sorted[sorted.length - 1], { year: false })}`;
    const frac = v.future / v.amount >= 0.5
      ? t('budgetInsights.callout.fracMost')
      : t('budgetInsights.callout.fracSome');
    future = t('budgetInsights.callout.future', { frac, range });
  }

  el.innerHTML = `
    <div class="bi-callout">
      <span class="bi-callout-icon" aria-hidden="true">!</span>
      <p class="bi-callout-text">${t('budgetInsights.callout.text', {
        country: _escHtml(_biCountryName(country)),
        pct, nights, totalNights, future,
      })}</p>
    </div>`;
}

// ── Init ────────────────────────────────────────

function _renderAll() {
  _renderContext();
  _renderPace();
  _renderCategories();
  _renderCountries();
  _renderCallout();
}

document.addEventListener('langchange', () => {
  if (_biBudget) _renderAll();
});

async function _init() {
  await initI18n();
  // initCurrency must resolve before rendering any amounts — toUSD() falls
  // back to a no-op conversion (returns the raw amount) until _rates is
  // populated, same reasoning as app.js's initCurrency-before-initBudget
  // sequencing (this page doesn't load app.js, so nothing else does it).
  const [budgetRes, tripRes, accomRes] = await Promise.all([
    fetch('/api/budget'),
    fetch('/api/trip'),
    fetch('/api/accommodations'),
    initCurrency(),
  ]);
  _biBudget = await budgetRes.json();
  _biTrip = await tripRes.json();
  _biAccommodations = await accomRes.json();
  _renderAll();
}

_init();
