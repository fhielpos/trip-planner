/* =============================================
   prefs — tiny localStorage-backed preference store
   Shared client prefs that don't belong on the server. `locale` stays
   owned by i18n.js; `theme` shares the raw 'theme' key with app.js's
   early boot script. Writes fire a 'prefschange' CustomEvent on window.
   ============================================= */

const Prefs = (() => {
  function get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return raw; }
    } catch {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    } catch { /* private mode / quota — prefs are best-effort */ }
    window.dispatchEvent(new CustomEvent('prefschange', { detail: { key, value } }));
  }

  return { get, set };
})();
