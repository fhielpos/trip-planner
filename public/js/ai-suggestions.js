/* =============================================
   AI Activity Suggestions — a small panel that asks the model for a few
   things to do on one trip day. Shared by the Today view (desktop +
   mobile) and the planner's day-card expand view.

   These are draft ideas: cards are drawn with a dashed edge (vs. the
   solid hairline of committed entries) and only enter the calendar once
   the user accepts one through the normal add-activity modal.

   The panel holds a per-day "pool" of suggestions (union of every
   category combo fetched so far). Toggling the category chips filters the
   pool locally — no network — and only an explicit "get more" or
   "refresh" hits the model again.
   ============================================= */

const AI_CATS = ['sightseeing', 'culture', 'outdoors', 'food', 'nightlife', 'shopping', 'daytrip'];
const AI_CATS_LS_KEY = 'tp_ai_categories';

function _aiEscHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Selected categories — persisted globally (not per-date), same pattern as
// the app's `lang` / `theme`. Always returns a clean whitelisted array.
function _aiSelectedCats() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_CATS_LS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(c => AI_CATS.includes(c)) : [];
  } catch { return []; }
}
function _aiSetSelectedCats(cats) {
  try { localStorage.setItem(AI_CATS_LS_KEY, JSON.stringify(cats)); } catch { /* private mode */ }
}

// Dismissed suggestions, per date — session-only, never persisted.
const _aiDismissed = new Map(); // dateStr -> Set<name>
function _aiDismissedSet(date) {
  if (!_aiDismissed.has(date)) _aiDismissed.set(date, new Set());
  return _aiDismissed.get(date);
}

// Per-date suggestion state, kept for the whole session. Survives closing
// the panel, switching days, adding an event, and any DOM re-render — so
// re-opening a day's panel shows the same pool with zero network. The
// only writes are a successful fetch (first open, Refresh, or "get
// more"); nothing else touches it.
const _aiCache = new Map(); // dateStr -> { pool: [] | null, refreshesLeft }
function _aiEntry(date) {
  if (!_aiCache.has(date)) {
    _aiCache.set(date, { pool: null, refreshesLeft: undefined });
  }
  return _aiCache.get(date);
}

function _aiLang() {
  return getDateLocale().slice(0, 2) === 'es' ? 'es' : 'en';
}

// No coordinates come back from the model, so "already on the calendar"
// is a title match against that day's entries (case-insensitive, either
// direction so "Louvre" matches "Louvre Museum").
function _aiAlreadyAdded(name, date) {
  const n = name.toLowerCase();
  return (tripData?.calendar || []).some(e => {
    if (e.date !== date || !e.title) return false;
    const t = e.title.toLowerCase();
    return t === n || t.includes(n) || n.includes(t);
  });
}

function _aiFmtDuration(h) {
  if (!h) return '';
  if (h === 1.5) return '1½h';
  if (h === Math.round(h)) return `${h}h`;
  return `${h}h`;
}

function _aiMsgEl(text) {
  const el = document.createElement('div');
  el.className = 'ai-panel-msg';
  el.textContent = text;
  return el;
}

// "Working" state while a fetch is in flight — the label plus a couple of
// pulsing dashed placeholders shaped like the cards that are coming.
function _aiLoadingEl() {
  const wrap = document.createElement('div');
  wrap.className = 'ai-loading';
  wrap.appendChild(_aiEyebrow());
  wrap.appendChild(_aiMsgEl(t('aiSuggestions.loading')));
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement('div');
    sk.className = 'ai-skel';
    sk.innerHTML = '<div class="ai-skel-bar"></div><div class="ai-skel-bar"></div><div class="ai-skel-bar"></div>';
    wrap.appendChild(sk);
  }
  return wrap;
}

function _aiEyebrow() {
  const el = document.createElement('div');
  el.className = 'today-block-title ai-panel-eyebrow';
  el.textContent = t('aiSuggestions.eyebrow');
  return el;
}

function _aiCard(s, date) {
  const added = _aiAlreadyAdded(s.name, date);
  const meta = [
    t('aiSuggestions.cat.' + s.category),
    _aiFmtDuration(s.durationHours),
    s.suggestedStartTime || '',
  ].filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = 'ai-card';
  card.innerHTML = `
    <div class="ai-card-top">
      <span class="ai-card-name">${_aiEscHtml(s.name)}</span>
      <div class="ai-card-actions">
        <button type="button" class="rec-card-add"${added ? ' disabled' : ''}>
          ${added ? t('aiSuggestions.added') : t('aiSuggestions.add')}
        </button>
        <button type="button" class="ai-card-dismiss" aria-label="${_aiEscHtml(t('aiSuggestions.dismiss'))}">&times;</button>
      </div>
    </div>
    ${meta ? `<div class="ai-card-meta">${_aiEscHtml(meta)}</div>` : ''}
    ${s.reason ? `<div class="ai-card-reason" title="${_aiEscHtml(s.reason)}">${_aiEscHtml(s.reason)}</div>` : ''}`;

  const reasonEl = card.querySelector('.ai-card-reason');
  reasonEl?.addEventListener('click', e => {
    e.stopPropagation();
    reasonEl.classList.toggle('ai-card-reason--expanded');
  });

  if (!added) {
    card.querySelector('.rec-card-add').addEventListener('click', e => {
      // Day cards have a click-to-expand handler on the card itself —
      // stop the click before it bubbles and toggles the card.
      e.stopPropagation();
      openAddModal(date, {
        title: s.name,
        address: s.address || '',
        notes: s.reason || '',
        startTime: s.suggestedStartTime || '',
      });
      // On save, app.js calls refreshOpenAiPanels() and this card leaves
      // the list (already on the calendar); on cancel nothing changes.
    });
  }
  card.querySelector('.ai-card-dismiss').addEventListener('click', e => {
    e.stopPropagation();
    _aiDismissedSet(date).add(s.name);
    card.classList.add('ai-card--leaving');
    setTimeout(() => _aiRenderPanel(card.closest('.ai-panel'), date), 160);
  });
  return card;
}

function _aiCatChips(container, date) {
  const selected = _aiSelectedCats();
  const row = document.createElement('div');
  row.className = 'ai-cat-row';
  AI_CATS.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ai-cat-chip' + (selected.includes(cat) ? ' is-on' : '');
    chip.textContent = t('aiSuggestions.cat.' + cat);
    chip.setAttribute('aria-pressed', selected.includes(cat) ? 'true' : 'false');
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const cur = _aiSelectedCats();
      _aiSetSelectedCats(cur.includes(cat) ? cur.filter(c => c !== cat) : [...cur, cat]);
      _aiRenderPanel(container, date); // local re-filter only, no network
    });
    row.appendChild(chip);
  });
  return row;
}

// Render the panel from the per-date cached pool, filtered by the
// selected chips. No network here.
function _aiRenderPanel(container, date) {
  if (!container) return;
  const entry = _aiEntry(date);
  const pool = entry.pool || [];
  const selected = _aiSelectedCats();
  const refreshesLeft = entry.refreshesLeft;

  container.dataset.aiDate = date; // lets refreshOpenAiPanels() re-render this one
  container.textContent = '';
  container.appendChild(_aiEyebrow());
  container.appendChild(_aiCatChips(container, date));

  // Drop anything dismissed or already on the calendar. app.js calls
  // refreshOpenAiPanels() after a calendar add, so an accepted suggestion
  // leaves the list right away (the greyed "Added" button in _aiCard only
  // shows in the brief window before that re-render).
  const dismissed = _aiDismissedSet(date);
  let shown = pool.filter(s => !dismissed.has(s.name) && !_aiAlreadyAdded(s.name, date));
  if (selected.length) shown = shown.filter(s => selected.includes(s.category));

  if (!shown.length) {
    container.appendChild(_aiMsgEl(t('aiSuggestions.empty')));
  } else {
    shown.slice(0, 6).forEach(s => container.appendChild(_aiCard(s, date)));
  }

  // "Get more of X" — a thin filtered result with a category filter on.
  // Steered fetch for that combo; the server serves it from cache if it
  // already has it, so this never wastes a call. Doesn't spend a refresh.
  if (selected.length && shown.length < 3) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ai-more';
    more.textContent = t('aiSuggestions.getMore', {
      cats: selected.map(c => t('aiSuggestions.cat.' + c)).join(', '),
    });
    more.addEventListener('click', e => {
      e.stopPropagation();
      _aiFetch(container, date, { more: true });
    });
    container.appendChild(more);
  }

  if (typeof refreshesLeft === 'number' && refreshesLeft > 0) {
    const foot = document.createElement('div');
    foot.className = 'ai-panel-foot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-refresh';
    btn.textContent = t('aiSuggestions.refresh');
    btn.addEventListener('click', e => { e.stopPropagation(); _aiFetch(container, date, { refresh: true }); });
    const count = document.createElement('span');
    count.className = 'ai-refresh-count';
    count.textContent = t('aiSuggestions.refreshesLeft', { n: refreshesLeft });
    foot.append(btn, count);
    container.appendChild(foot);
  }
}

// The only thing that talks to the server — first open of a date,
// Refresh, or "get more". The server still serves from its own cache
// unless `refresh` (or a `more` for a not-yet-fetched combo), so most
// calls here don't reach the model. Updates the per-date cache.
async function _aiFetch(container, date, { refresh = false, more = false } = {}) {
  const cats = _aiSelectedCats();
  container.textContent = '';
  container.appendChild(_aiLoadingEl());

  try {
    const res = await fetch(`/api/ai-suggestions?lang=${_aiLang()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, refresh, more, categories: cats }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const when = body.lockedUntil ? fmtDate(String(body.lockedUntil).slice(0, 10), { year: false }) : '';
      _aiRenderPanel(container, date);
      container.appendChild(_aiMsgEl(t('aiSuggestions.locked', { date: when })));
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`[ai-suggestions] ${res.status}:`, body.error || res.statusText);
      _aiRenderPanel(container, date);
      container.appendChild(_aiMsgEl(t('aiSuggestions.loadFailed')));
      return;
    }

    const payload = await res.json();
    const entry = _aiEntry(date);
    entry.pool = Array.isArray(payload.pool) ? payload.pool : [];
    entry.refreshesLeft = payload.refreshesLeft;
    _aiRenderPanel(container, date);
  } catch (e) {
    console.error('[ai-suggestions] request failed:', e);
    _aiRenderPanel(container, date);
    container.appendChild(_aiMsgEl(t('aiSuggestions.loadFailed')));
  }
}

// Entry point — called by the Today toggles and the day-card button
// every time a panel opens. Serves the session cache with no network;
// only the very first open of a date fetches.
function renderAiSuggestions(container, date) {
  container.classList.add('rec-panel', 'ai-panel');
  // Day cards own a click-to-expand handler; keep panel clicks from reaching it.
  if (!container.dataset.clickTrapped) {
    container.dataset.clickTrapped = '1';
    container.addEventListener('click', e => e.stopPropagation());
  }
  if (_aiEntry(date).pool !== null) {
    _aiRenderPanel(container, date);
  } else {
    _aiFetch(container, date, { refresh: false });
  }
}

// Re-render any open suggestion panel from its cached pool (no network) —
// called by app.js after a calendar add/edit/delete so a suggestion that
// now matches a calendar entry gets removed from the list at once.
function refreshOpenAiPanels() {
  document.querySelectorAll('.ai-panel').forEach(el => {
    const date = el.dataset.aiDate;
    if (el.hidden || !date || _aiEntry(date).pool === null) return;
    _aiRenderPanel(el, date);
  });
}

// Close every open suggestion panel — called by app.js when the add/edit
// modal opens, so the panel (which floats above the map, z-index 1002)
// can't sit on top of the dialog. The pool stays in _aiCache, so
// re-opening is instant and loses nothing.
function closeOpenAiPanels() {
  document.querySelectorAll('.day-recs-panel[data-ai-for]').forEach(p => p.remove());
  document.querySelectorAll('#today-ai-panel, #mtoday-ai-panel').forEach(p => {
    p.hidden = true;
    delete p.dataset.loaded; // next open re-renders from _aiCache (no fetch), dropping any just-added card
  });
}
