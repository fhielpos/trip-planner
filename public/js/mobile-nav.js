/* =============================================
   Mobile Tab Shell — tab bar, bottom sheet, toast
   Active only ≤640px; every export is a no-op-safe
   global other modules call into unconditionally.
   ============================================= */

const MOBILE_BREAKPOINT = 640;

function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

const _mobileRerenderFns = [];
function registerMobileRerender(fn) {
  _mobileRerenderFns.push(fn);
}

let _lastMobileState = isMobileViewport();
window.addEventListener('resize', () => {
  const nowMobile = isMobileViewport();
  if (nowMobile !== _lastMobileState) {
    _lastMobileState = nowMobile;
    _mobileRerenderFns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }
});

function setMobileTab(tab) {
  document.body.dataset.mobileTab = tab;
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (typeof closeAddFab === 'function') closeAddFab();
  window.scrollTo(0, 0);
  // #trip-map is built while hidden behind the default Today tab; Leaflet
  // needs an explicit re-measure + re-fit once it actually becomes visible.
  if (tab === 'map' && typeof refreshMapView === 'function') {
    requestAnimationFrame(() => refreshMapView());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.body.dataset.mobileTab = 'today';
  document.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => setMobileTab(btn.dataset.tab));
  });

  document.getElementById('day-sheet-close')?.addEventListener('click', closeSheet);
  document.getElementById('day-sheet-backdrop')?.addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('day-sheet')?.hidden) closeSheet();
  });

  // Header ··· → Settings sheet (implemented in settings.js)
  document.getElementById('m-header-menu')?.addEventListener('click', () => {
    if (typeof openSettingsSheet === 'function') openSettingsSheet();
  });

  initAddFab();
});

// ── Add FAB + type-picker fan ───────────────────

function _fabDateLabel() {
  try {
    const d = typeof parseLocal === 'function' && typeof appToday === 'function'
      ? parseLocal(appToday()) : new Date();
    const loc = typeof getDateLocale === 'function' ? getDateLocale() : undefined;
    return d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function openAddFab() {
  const menu = document.getElementById('m-fab-menu');
  const fab = document.getElementById('m-fab');
  if (!menu || !fab) return;
  const setCtx = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt || ''; };
  setCtx('m-fab-ctx-activity', _fabDateLabel());
  setCtx('m-fab-ctx-expense', typeof t === 'function' ? t('fab.today') : '');
  menu.hidden = false;
  document.body.classList.add('m-fab-open');
  fab.setAttribute('aria-expanded', 'true');
}

function closeAddFab() {
  const menu = document.getElementById('m-fab-menu');
  const fab = document.getElementById('m-fab');
  if (menu) menu.hidden = true;
  document.body.classList.remove('m-fab-open');
  if (fab) fab.setAttribute('aria-expanded', 'false');
}

function toggleAddFab() {
  document.body.classList.contains('m-fab-open') ? closeAddFab() : openAddFab();
}

function _fabDefaultDate() {
  if (typeof appToday !== 'function' || typeof tripData === 'undefined' || !tripData?.trip) {
    return typeof appToday === 'function' ? appToday() : undefined;
  }
  const today = appToday();
  return (today >= tripData.trip.startDate && today <= tripData.trip.endDate)
    ? today : tripData.trip.startDate;
}

function _fabDispatch(kind) {
  closeAddFab();
  const date = _fabDefaultDate();
  switch (kind) {
    case 'activity':
      if (typeof openAddModal === 'function') openAddModal(date);
      break;
    case 'stay':
      if (typeof openAddModal === 'function') {
        openAddModal(date);
        if (typeof setType === 'function') setType('accommodation');
      }
      break;
    case 'expense':
      if (typeof _openExpenseModal === 'function') _openExpenseModal(null);
      break;
    case 'wishlist':
      if (typeof _openWishlistModal === 'function') _openWishlistModal();
      break;
  }
}

function initAddFab() {
  document.getElementById('m-fab')?.addEventListener('click', toggleAddFab);
  document.getElementById('m-fab-scrim')?.addEventListener('click', closeAddFab);
  document.querySelectorAll('.m-fab-item').forEach(btn => {
    btn.addEventListener('click', () => _fabDispatch(btn.dataset.add));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('m-fab-open')) closeAddFab();
  });
}

// ── Day Sheet ───────────────────────────────────

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openSheet({ title, color, rows, empty }) {
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('day-sheet-backdrop');
  if (!sheet || !backdrop) return;

  document.getElementById('day-sheet-title').textContent = title;
  document.getElementById('day-sheet-title').style.color = color || 'var(--accent)';

  const body = document.getElementById('day-sheet-body');
  body.innerHTML = empty
    ? `<div class="sheet-empty">${t('daySheet.empty')}</div>`
    : rows.map(r => `
        <div class="sheet-row">
          <span class="sheet-row-icon">${r.icon}</span>
          <span class="sheet-row-title">${_escHtml(r.title)}</span>
        </div>`).join('');

  backdrop.hidden = false;
  sheet.hidden = false;
}

function closeSheet() {
  const sheet = document.getElementById('day-sheet');
  const backdrop = document.getElementById('day-sheet-backdrop');
  if (sheet) sheet.hidden = true;
  if (backdrop) backdrop.hidden = true;
}

// ── Toast ───────────────────────────────────────

let _toastTimer = null;
function showToast(message) {
  const el = document.getElementById('mobile-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 1600);
}
