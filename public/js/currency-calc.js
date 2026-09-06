/* =============================================
   Currency Calculator — mobile-only price-tag converter
   in the Budget tab (handoff frame 5b). A single tag-price
   input plus a currency chip; the budget-currency result,
   the rate, ARS/EUR context and quick references are all
   derived. Standalone — it never creates an expense.
   ============================================= */

const CALC_PAIR_KEY = 'currencyCalcPair';
const CALC_QUICK_REFS = [10, 20, 50, 100];

let _calcTo = null;          // budget-side currency (no on-screen picker)
let _calcOcrObjectUrl = null;

function _calcLoadPair() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALC_PAIR_KEY));
    if (saved && saved.from) return saved;
  } catch { /* fall through to default */ }
  return { from: 'CHF', to: null };
}

function _calcSavePair() {
  localStorage.setItem(CALC_PAIR_KEY, JSON.stringify({ from: _calcGetCurrency('from'), to: _calcTo }));
}

function _calcGetCurrency(which) {
  if (which === 'to') return _calcTo || 'USD';
  return document.getElementById('calc-currency-from-select').value || 'USD';
}

function _calcBudgetCurrency() {
  return typeof getBudgetCurrency === 'function' ? getBudgetCurrency() : 'USD';
}

// (Re)fill the tag-currency chip's <option> list — the quick picks first,
// then any other known currency the live rates carry.
function _calcPopulateCurrencies(selected) {
  const select = document.getElementById('calc-currency-from-select');
  const known = typeof listKnownCurrencies === 'function' ? listKnownCurrencies() : [];
  const codes = [...new Set([...CURRENCY_QUICK_PICKS, ...known, selected].filter(Boolean))];
  select.innerHTML = codes.map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`).join('');
}

function _calcSetCurrency(which, code) {
  if (!code) return;
  if (which === 'to') {
    _calcTo = code;
  } else {
    _calcPopulateCurrencies(code);
  }
  _calcSavePair();
  _calcRender();
  _calcRecompute();
}

function _calcFmtCcy(value, ccy) {
  try {
    return new Intl.NumberFormat(getDateLocale(), {
      style: 'currency', currency: ccy,
      minimumFractionDigits: 0, maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return ccy + ' ' + value.toLocaleString(getDateLocale(), { maximumFractionDigits: 2 });
  }
}

// ARS is written "ARS 163.108" (code prefix, no decimals) so it never
// collides with the "$" the locale would also give USD.
function _calcFmtLeg(value, ccy) {
  if (ccy === 'ARS') return 'ARS ' + Math.round(value).toLocaleString(getDateLocale());
  return _calcFmtCcy(value, ccy);
}

// Only updates the computed result — deliberately does NOT rebuild the
// rate line / quick refs (that is _calcRender), since this runs on every
// keystroke in the amount field.
function _calcRecompute() {
  const raw = document.getElementById('calc-amount-from').value.replace(/\s/g, '').replace(',', '.');
  const amount = parseFloat(raw);
  const from = _calcGetCurrency('from');
  const to = _calcGetCurrency('to');
  const resultEl = document.getElementById('calc-amount-to');
  const altEl = document.getElementById('calc-result-alt');
  if (!Number.isFinite(amount)) {
    resultEl.textContent = '—';
    altEl.textContent = '';
    return;
  }
  const result = convertAmount(amount, from, to);
  resultEl.textContent = result === null ? t('budget.calc.rateUnavailable') : _calcFmtCcy(result, to);

  const legs = ['USD', 'ARS', 'EUR']
    .filter(c => c !== to && c !== from)
    .map(c => { const v = convertAmount(amount, from, c); return v === null ? null : _calcFmtLeg(v, c); })
    .filter(Boolean);
  altEl.textContent = legs.join(' · ');
}

// Header rate-age sub-line, the "1 CHF = 1,26 USD" rate, the swap-button
// label, the quick-reference chips and the footer copy — everything that
// depends on the currency pair but not on the typed amount.
function _calcRender() {
  const from = _calcGetCurrency('from');
  const to = _calcGetCurrency('to');

  const ageEl = document.getElementById('calc-rate-age');
  const at = typeof getRatesFetchedAt === 'function' ? getRatesFetchedAt() : null;
  if (!at) {
    ageEl.textContent = t('budget.calc.rateAgeUnknown');
  } else {
    const days = Math.floor((Date.now() - new Date(at).getTime()) / 86400000);
    ageEl.textContent = days <= 0 ? t('budget.calc.rateAgeToday') : t('budget.calc.rateAge', { n: days });
  }

  const rateEl = document.getElementById('calc-rate-line');
  const unit = convertAmount(1, from, to);
  rateEl.textContent = (from === to || unit === null)
    ? ''
    : `1 ${from} = ${unit.toLocaleString(getDateLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${to}`;

  document.getElementById('calc-swap-label').textContent = `⇄ ${from}↔${to}`;

  const chipsEl = document.getElementById('calc-quickref-chips');
  chipsEl.innerHTML = CALC_QUICK_REFS.map(n => {
    const v = convertAmount(n, from, to);
    const val = v === null ? '—' : _calcFmtCcy(v, to);
    return `<span class="label mono calc-quickref-chip">${from} ${n} = ${val}</span>`;
  }).join('');

  document.getElementById('calc-footer').innerHTML =
    t('budget.calc.noSave', { action: `<span class="calc-footer-accent">+ ${t('fab.expense')}</span>` });
}

function _openCalcModal() {
  const pair = _calcLoadPair();
  _calcTo = pair.to || _calcBudgetCurrency();
  _calcPopulateCurrencies(pair.from || 'CHF');
  _calcHideOcr();
  document.getElementById('calc-scan-status').hidden = true;
  _calcRender();
  _calcRecompute();
  document.getElementById('currency-calc-overlay').hidden = false;
}
function _closeCalcModal() {
  document.getElementById('currency-calc-overlay').hidden = true;
}

function _calcHideOcr() {
  const box = document.getElementById('calc-ocr');
  box.hidden = true;
  if (_calcOcrObjectUrl) { URL.revokeObjectURL(_calcOcrObjectUrl); _calcOcrObjectUrl = null; }
}

document.getElementById('mbudget-convert-btn').addEventListener('click', _openCalcModal);
document.getElementById('currency-calc-close').addEventListener('click', _closeCalcModal);
wireModal(document.getElementById('currency-calc-overlay'), _closeCalcModal);

document.getElementById('calc-amount-from').addEventListener('input', _calcRecompute);

document.getElementById('calc-currency-from-select').addEventListener('change', e => {
  _calcSetCurrency('from', e.target.value);
});

document.getElementById('calc-swap-btn').addEventListener('click', () => {
  const from = _calcGetCurrency('from');
  const to = _calcGetCurrency('to');
  _calcTo = from;
  _calcPopulateCurrencies(to);
  _calcSavePair();
  _calcRender();
  _calcRecompute();
});

document.getElementById('calc-ocr-fix').addEventListener('click', () => {
  const input = document.getElementById('calc-amount-from');
  input.focus();
  input.select();
});

document.getElementById('calc-scan-btn').addEventListener('click', () => {
  document.getElementById('calc-receipt-input').click();
});

document.getElementById('calc-receipt-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file next time
  if (!file) return;

  const scanBtn = document.getElementById('calc-scan-btn');
  const statusEl = document.getElementById('calc-scan-status');
  statusEl.hidden = true;
  _calcHideOcr();
  scanBtn.disabled = true;
  const originalLabel = scanBtn.textContent;
  scanBtn.textContent = t('budget.entry.scanning');

  const reading = await scanReceiptTag(file);

  scanBtn.disabled = false;
  scanBtn.textContent = originalLabel;

  if (!reading || reading.amount === null) {
    statusEl.textContent = t('budget.entry.scanFailed');
    statusEl.hidden = false;
    return;
  }

  const from = _calcGetCurrency('from');
  document.getElementById('calc-amount-from').value = reading.amount;
  _calcRecompute();

  _calcOcrObjectUrl = URL.createObjectURL(file);
  document.getElementById('calc-ocr-img').src = _calcOcrObjectUrl;
  document.getElementById('calc-ocr-conf').textContent =
    t('budget.calc.confidence', { n: Math.max(0, Math.min(100, Math.round(reading.confidence || 0))) });
  document.getElementById('calc-ocr-msg').textContent = t('budget.calc.ocrRead', {
    ccy: from,
    amount: reading.amount.toLocaleString(getDateLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
  document.getElementById('calc-ocr').hidden = false;
});

if (typeof Tesseract === 'undefined') {
  const scanBtn = document.getElementById('calc-scan-btn');
  scanBtn.disabled = true;
  scanBtn.title = t('budget.entry.scanUnavailable');
}

document.addEventListener('langchange', () => {
  if (!document.getElementById('currency-calc-overlay').hidden) {
    _calcRender();
    _calcRecompute();
  }
});
