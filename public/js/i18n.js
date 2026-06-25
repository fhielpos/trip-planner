/* =============================================
   i18n — lightweight translations
   ============================================= */

const LOCALES = {};
let _lang = 'en';

async function initI18n() {
  _lang = localStorage.getItem('lang') || 'es';
  const [en, es] = await Promise.all([
    fetch('/locales/en.json').then(r => r.json()),
    fetch('/locales/es.json').then(r => r.json()),
  ]);
  LOCALES.en = en;
  LOCALES.es = es;
  _applyStatic();
  _updateBtn();
}

// Translate a key, optionally substituting {param} placeholders
function t(key, params = {}) {
  const dict = LOCALES[_lang] || LOCALES.en || {};
  let str = Object.prototype.hasOwnProperty.call(dict, key)
    ? dict[key]
    : (LOCALES.en?.[key] ?? key);
  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}

function setLang(lang) {
  if (!LOCALES[lang]) return;
  _lang = lang;
  localStorage.setItem('lang', lang);
  _applyStatic();
  _updateBtn();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

function getLang() { return _lang; }

// Returns the BCP-47 locale string to pass to toLocaleDateString
function getDateLocale() {
  return _lang === 'es' ? 'es-ES' : 'en-US';
}

function _applyStatic() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

function _updateBtn() {
  const btn = document.getElementById('lang-toggle');
  if (btn) btn.textContent = _lang.toUpperCase();
}

// Wire toggle button (DOM is already ready when this script runs)
document.getElementById('lang-toggle').addEventListener('click', () => {
  setLang(_lang === 'en' ? 'es' : 'en');
});
