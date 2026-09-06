/* =============================================
   Settings sheet (≤640px) — everything the redesign moved out of the
   header: language, theme, currency/rates, AI-suggestions status, data
   (export / install), sign out. Opened from the header ··· button.
   ============================================= */

let _settingsOpen = false;
let _deferredInstallPrompt = null;

function openSettingsSheet() {
  const sheet = document.getElementById('settings-sheet');
  if (!sheet) return;
  renderSettingsSheet();
  sheet.hidden = false;
  _settingsOpen = true;
  document.getElementById('m-header-menu')?.setAttribute('aria-expanded', 'true');
}

function closeSettingsSheet() {
  const sheet = document.getElementById('settings-sheet');
  if (sheet) sheet.hidden = true;
  _settingsOpen = false;
  document.getElementById('m-header-menu')?.setAttribute('aria-expanded', 'false');
}

function _isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function _ratesAge() {
  const iso = typeof getRatesFetchedAt === 'function' ? getRatesFetchedAt() : null;
  if (!iso) return { label: t('settings.ratesUnknown'), stale: true };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  const stale = days >= 3;
  const base = days <= 0 ? t('settings.ratesToday') : t('settings.ratesDaysAgo', { n: days });
  return { label: stale ? `${base} · ${t('settings.offlineWord')}` : base, stale };
}

function _themeCard(id, name, chips, current) {
  return `
    <button type="button" class="settings-theme${current === id ? ' is-active' : ''}" data-theme-val="${id}">
      <span class="settings-theme-chips">${chips}</span>
      <span class="settings-theme-name">${name}</span>
    </button>`;
}

function renderSettingsSheet() {
  const body = document.getElementById('settings-sheet-body');
  if (!body) return;

  const theme = typeof getTheme === 'function' ? getTheme() : 'carbon';
  const lang = localStorage.getItem('lang') || 'es';
  const ars = (typeof Prefs !== 'undefined' && Prefs.get('arsDisplay', 'tap')) || 'tap';
  const budgetCur = typeof getBudgetCurrency === 'function' ? (getBudgetCurrency() || '—') : '—';
  const aiOn = !!(typeof tripData !== 'undefined' && tripData && tripData.config && tripData.config.aiSuggestionsEnabled);
  const rates = _ratesAge();
  const showInstall = Boolean(_deferredInstallPrompt) && !_isStandalone();

  const seg = (name, val, opts) => `
    <div class="settings-seg${name === 'ars' ? ' settings-mini-seg' : ''}" data-seg="${name}">
      ${opts.map(o => `<button type="button" class="settings-seg-btn${val === o.v ? ' is-active' : ''}" data-val="${o.v}">${o.label}</button>`).join('')}
    </div>`;

  body.innerHTML = `
    <div class="settings-group">
      <div class="settings-group-label">${t('settings.language')}</div>
      ${seg('lang', lang, [{ v: 'es', label: 'Español' }, { v: 'en', label: 'English' }])}
    </div>

    <div class="settings-group">
      <div class="settings-group-label">${t('settings.theme')}</div>
      <div class="settings-themes">
        ${_themeCard('carbon', t('settings.themeCarbon'),
          '<span style="background:#181614;border:1px solid rgba(240,235,228,.2)"></span><span style="background:#d4a87c"></span>', theme)}
        ${_themeCard('terracotta', t('settings.themeTerracotta'),
          '<span style="background:#f2e8dc;border:1px solid rgba(0,0,0,.15)"></span><span style="background:#b4623f"></span>', theme)}
        ${_themeCard('system', t('settings.themeSystem'),
          '<span style="background:linear-gradient(135deg,#181614 50%,#f2e8dc 50%);border:1px solid rgba(240,235,228,.18)"></span>', theme)}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">${t('settings.currencyRates')}</div>
      <div class="settings-card">
        <button type="button" class="settings-row" id="settings-budget-cur">
          <span class="settings-row-main"><span class="settings-row-title">${t('settings.budgetCurrency')}</span></span>
          <span class="settings-row-value">${budgetCur}</span>
          <span class="settings-row-chevron">›</span>
        </button>
        <div class="settings-row">
          <span class="settings-row-main"><span class="settings-row-title">${t('settings.showArs')}</span></span>
          ${seg('ars', ars, [
            { v: 'tap', label: t('settings.arsTap') },
            { v: 'always', label: t('settings.arsAlways') },
            { v: 'never', label: t('settings.arsNever') },
          ])}
        </div>
        <div class="settings-row">
          <span class="settings-row-main">
            <span class="settings-row-title">${t('settings.exchangeRates')}</span>
            <span class="settings-row-sub${rates.stale ? ' is-warning' : ''}">${rates.label}</span>
          </span>
          <button type="button" class="settings-pill-btn" id="settings-refresh-rates">${t('settings.update')}</button>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">${t('settings.aiSuggestions')}</div>
      <div class="settings-card is-provisional" style="padding:13px">
        <div class="settings-row" style="border:0;padding:0">
          <span class="settings-row-main">
            <span class="settings-row-title">${t('settings.aiSuggestions')}</span>
            <span class="settings-row-sub">${aiOn ? t('settings.aiActive') : t('settings.aiInactive')}</span>
          </span>
          ${aiOn ? '<span class="settings-row-done">●</span>' : ''}
        </div>
        ${aiOn ? '' : `<p class="settings-note">${t('settings.aiReassure')}</p>`}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-label">${t('settings.data')}</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-main">
            <span class="settings-row-title">${t('settings.offlineMap')}</span>
            <span class="settings-row-sub">${t('settings.notConfigured')}</span>
          </span>
        </div>
        <button type="button" class="settings-row" id="settings-export">
          <span class="settings-row-main">
            <span class="settings-row-title">${t('settings.exportTrip')}</span>
            <span class="settings-row-sub">JSON</span>
          </span>
          <span class="settings-row-chevron">›</span>
        </button>
        ${showInstall ? `
        <div class="settings-row">
          <span class="settings-row-main"><span class="settings-row-title">${t('settings.install')}</span></span>
          <button type="button" class="settings-pill-btn" id="settings-install">${t('settings.installBtn')}</button>
        </div>` : ''}
      </div>
    </div>

    <button type="button" class="settings-signout" id="settings-signout">${t('settings.signOut')}</button>
  `;

  _wireSettingsBody();
}

function _wireSettingsBody() {
  const body = document.getElementById('settings-sheet-body');
  if (!body) return;

  body.querySelector('[data-seg="lang"]')?.addEventListener('click', e => {
    const btn = e.target.closest('.settings-seg-btn');
    if (btn && typeof setLang === 'function') { setLang(btn.dataset.val); renderSettingsSheet(); }
  });

  body.querySelector('[data-seg="ars"]')?.addEventListener('click', e => {
    const btn = e.target.closest('.settings-seg-btn');
    if (btn && typeof Prefs !== 'undefined') { Prefs.set('arsDisplay', btn.dataset.val); renderSettingsSheet(); }
  });

  body.querySelectorAll('[data-theme-val]').forEach(card => {
    card.addEventListener('click', () => {
      if (typeof setTheme === 'function') setTheme(card.dataset.themeVal);
      renderSettingsSheet();
    });
  });

  body.querySelector('#settings-budget-cur')?.addEventListener('click', () => {
    closeSettingsSheet();
    if (typeof _openSettingsModal === 'function') _openSettingsModal();
  });

  body.querySelector('#settings-refresh-rates')?.addEventListener('click', async e => {
    if (typeof refreshCurrency !== 'function') return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await refreshCurrency(); } catch { /* offline — keep the cached rates */ }
    renderSettingsSheet();
  });

  body.querySelector('#settings-export')?.addEventListener('click', () => {
    window.location.href = '/api/export';
  });

  body.querySelector('#settings-install')?.addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    await _deferredInstallPrompt.userChoice.catch(() => {});
    _deferredInstallPrompt = null;
    renderSettingsSheet();
  });

  body.querySelector('#settings-signout')?.addEventListener('click', () => {
    if (typeof logout === 'function') logout();
  });
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  if (_settingsOpen) renderSettingsSheet();
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('settings-done')?.addEventListener('click', closeSettingsSheet);
  document.getElementById('settings-sheet')?.addEventListener('click', e => {
    // click on the scrim (the sheet element itself), not the panel
    if (e.target.id === 'settings-sheet') closeSettingsSheet();
  });

  const settingsPanel = document.querySelector('#settings-sheet .settings-sheet-panel');
  if (settingsPanel && typeof attachSheetDrag === 'function') {
    attachSheetDrag(settingsPanel, {
      zoneSelector: '.settings-sheet-handle, .settings-sheet-titles',
      onClose: closeSettingsSheet,
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _settingsOpen) closeSettingsSheet();
  });
  const v = document.getElementById('settings-version');
  if (v) {
    fetch('/api/version').then(r => r.json()).then(({ commit }) => {
      v.textContent = `${String(commit || '').slice(0, 7)} · offline`;
    }).catch(() => {});
  }
});

document.addEventListener('langchange', () => { if (_settingsOpen) renderSettingsSheet(); });
