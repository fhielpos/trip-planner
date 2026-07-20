/* =============================================
   Currency — shared conversion & formatting
   Single source of truth for exchange rates, shared by budget.js,
   wishlist.js, and budget-insights.js (replaces their previously
   duplicated currency formatters).
   ============================================= */

let _rates = { base: 'USD', fetchedAt: null, rates: {} };

// Shared by budget.js's and wishlist.js's currency pickers — declared once
// here since both files load in the same global scope on index.html, and
// two top-level `const` declarations of the same name in that scope would
// be a SyntaxError (unlike function redeclaration, which is tolerated).
const CURRENCY_QUICK_PICKS = ['USD', 'EUR', 'CHF', 'ARS'];

async function _fetchRates() {
  try {
    const res = await fetch('/api/rates');
    return await res.json();
  } catch {
    return { base: 'USD', fetchedAt: null, rates: {} };
  }
}

async function initCurrency() {
  _rates = await _fetchRates();
}

async function refreshCurrency() {
  _rates = await _fetchRates();
}

function _effectiveRate(currency) {
  if (!currency || currency === 'USD') return 1;
  return _rates.rates?.[currency]?.effective ?? null;
}

// Falls back to treating an unknown currency as already-USD rather than
// throwing — better to show a slightly-wrong number than crash a render.
function toUSD(amount, currency) {
  if (!currency || currency === 'USD') return amount;
  const rate = _effectiveRate(currency);
  return rate ? amount / rate : amount;
}

function toARS(amountUSD) {
  const rate = _effectiveRate('ARS');
  return rate ? amountUSD * rate : null;
}

function formatMoney(amount, currency) {
  const c = currency || 'USD';
  try {
    return new Intl.NumberFormat(getDateLocale(), {
      style: 'currency', currency: c, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return c + ' ' + Math.round(amount).toLocaleString();
  }
}

// For already-USD-converted aggregate figures (totals, remaining, etc.).
function formatCurrency(amount) {
  return formatMoney(amount, 'USD');
}

// Small secondary conversion line for an individual row, e.g.
// "≈ $32.50 · ARS 32.500" — omits any leg that would just restate the
// entry's own currency (a USD entry shows only ARS, an ARS entry shows
// only USD, anything else shows both).
function conversionLine(amount, currency) {
  const parts = [];
  const usd = currency === 'USD' ? amount : toUSD(amount, currency);
  if (currency !== 'USD') parts.push('≈ ' + formatMoney(usd, 'USD'));
  if (currency !== 'ARS') {
    const ars = toARS(usd);
    if (ars !== null) parts.push('ARS ' + Math.round(ars).toLocaleString());
  }
  return parts.length ? `<span class="currency-conversion">${parts.join(' · ')}</span>` : '';
}

function listKnownCurrencies() {
  return Object.keys(_rates.rates || {}).sort();
}

function getRateInfo(currency) {
  return _rates.rates?.[currency] || { fetched: null, override: null, effective: null };
}

function getRatesFetchedAt() {
  return _rates.fetchedAt || null;
}
