/* =============================================
   Currency Calculator — mobile-only quick converter
   in the Budget tab, with an inline rate-override
   control and a price-tag OCR scan button.
   ============================================= */

function _calcGetCurrency(which) {
  const active = document.querySelector(`#calc-currency-${which}-selector .type-btn.active[data-currency]`);
  if (active) return active.dataset.currency;
  const select = document.getElementById(`calc-currency-${which}-select`);
  return select.hidden ? 'USD' : select.value;
}

function _calcSetCurrency(which, code) {
  const buttons = document.querySelectorAll(`#calc-currency-${which}-selector .type-btn[data-currency]`);
  const select = document.getElementById(`calc-currency-${which}-select`);
  const isQuickPick = CURRENCY_QUICK_PICKS.includes(code);
  buttons.forEach(b => b.classList.toggle('active', isQuickPick && b.dataset.currency === code));
  document.getElementById(`calc-currency-${which}-more`).classList.toggle('active', !isQuickPick);
  if (isQuickPick) {
    select.hidden = true;
  } else {
    const known = listKnownCurrencies();
    const codes = known.includes(code) ? known : [...known, code].sort();
    select.innerHTML = codes.map(c => `<option value="${c}"${c === code ? ' selected' : ''}>${c}</option>`).join('');
    select.hidden = false;
  }
  _calcRecompute();
}

// Only updates the computed result — deliberately does NOT touch
// #calc-rate-info (Task 4 renders that separately, from _calcSetCurrency),
// since this runs on every keystroke in the amount field and rebuilding
// the rate-info HTML on every keystroke would collapse any open
// rate-override editor while the user is still typing.
function _calcRecompute() {
  const amount = parseFloat(document.getElementById('calc-amount-from').value);
  const from = _calcGetCurrency('from');
  const to = _calcGetCurrency('to');
  const resultEl = document.getElementById('calc-amount-to');
  if (!Number.isFinite(amount)) {
    resultEl.value = '';
    return;
  }
  const result = convertAmount(amount, from, to);
  resultEl.value = result === null ? t('budget.calc.rateUnavailable') : formatMoney(result, to);
}

function _openCalcModal() {
  document.getElementById('currency-calc-overlay').hidden = false;
}
function _closeCalcModal() {
  document.getElementById('currency-calc-overlay').hidden = true;
}

document.getElementById('mbudget-convert-btn').addEventListener('click', _openCalcModal);
document.getElementById('currency-calc-close').addEventListener('click', _closeCalcModal);
wireModal(document.getElementById('currency-calc-overlay'), _closeCalcModal);

document.getElementById('calc-amount-from').addEventListener('input', _calcRecompute);

document.getElementById('calc-swap-btn').addEventListener('click', () => {
  const from = _calcGetCurrency('from');
  const to = _calcGetCurrency('to');
  _calcSetCurrency('from', to);
  _calcSetCurrency('to', from);
});

['from', 'to'].forEach(which => {
  document.getElementById(`calc-currency-${which}-selector`).addEventListener('click', e => {
    const btn = e.target.closest('.type-btn');
    if (!btn) return;
    if (btn.id === `calc-currency-${which}-more`) {
      _calcSetCurrency(which, listKnownCurrencies()[0] || 'GBP');
      document.getElementById(`calc-currency-${which}-select`).focus();
    } else {
      _calcSetCurrency(which, btn.dataset.currency);
    }
  });
  document.getElementById(`calc-currency-${which}-select`).addEventListener('change', e => {
    _calcSetCurrency(which, e.target.value);
  });
});

_calcSetCurrency('from', 'USD');
_calcSetCurrency('to', 'EUR');
