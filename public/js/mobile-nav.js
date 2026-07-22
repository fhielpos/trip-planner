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
});

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
