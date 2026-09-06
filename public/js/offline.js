/* =============================================
   Offline support — service worker registration
   ============================================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW registration failed', err));
  });
}

/* =============================================
   Offline connectivity indicator
   ============================================= */

function _updateOfflineIndicator() {
  const el = document.getElementById('offline-indicator');
  if (el) el.hidden = navigator.onLine;
  // Mobile redesign header carries the same online/offline state.
  if (typeof _updateHeaderSync === 'function') _updateHeaderSync();
}

window.addEventListener('online', _updateOfflineIndicator);
window.addEventListener('offline', _updateOfflineIndicator);
_updateOfflineIndicator();
