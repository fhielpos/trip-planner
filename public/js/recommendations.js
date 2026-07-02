/* =============================================
   Attraction Recommendations — shared panel used
   by both the Today view and the planner's
   day-card expand view.
   ============================================= */

function _recEscHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// A recommendation is "already added" if some calendar entry already has
// a lat/lon within ~10m of it — cross-referenced client-side against
// tripData.calendar, no new data needed.
function _recAlreadyAdded(rec) {
  return (tripData?.calendar || []).some(e =>
    e.lat != null && e.lon != null &&
    Math.abs(e.lat - rec.lat) < 0.0001 && Math.abs(e.lon - rec.lon) < 0.0001
  );
}

function _recCard(rec, defaultDate) {
  const added = _recAlreadyAdded(rec);
  const card = document.createElement('div');
  card.className = 'rec-card';
  card.innerHTML = `
    <div class="rec-card-info">
      <span class="rec-card-name">${_recEscHtml(rec.name)}</span>
      <span class="rec-card-category">${_recEscHtml(rec.category)}</span>
    </div>
    <button type="button" class="rec-card-add"${added ? ' disabled' : ''}>
      ${added ? t('recommendations.added') : t('recommendations.add')}
    </button>`;
  if (!added) {
    card.querySelector('.rec-card-add').addEventListener('click', e => {
      // Recommendation panels can be nested inside a day-card, which has
      // its own click-to-expand/collapse handler — without this, an
      // unstopped click bubbles up and toggles the card mid-interaction.
      e.stopPropagation();
      openAddModal(defaultDate, {
        title:   rec.name,
        address: rec.address || '',
        lat:     rec.lat,
        lon:     rec.lon,
      });
    });
  }
  return card;
}

async function renderRecommendations(container, stayId, defaultDate) {
  container.innerHTML = '';
  container.classList.add('rec-panel');
  // Belt-and-suspenders alongside the Add button's own stopPropagation:
  // catches clicks on card text/whitespace too, so nothing in here can
  // reach a parent day-card's click-to-expand/collapse handler.
  container.addEventListener('click', e => e.stopPropagation());
  try {
    const res = await fetch(`/api/recommendations/${stayId}`);
    if (!res.ok) { container.textContent = t('recommendations.loadFailed'); return; }
    const recs = await res.json();
    if (!recs.length) { container.textContent = t('recommendations.empty'); return; }
    recs.forEach(rec => container.appendChild(_recCard(rec, defaultDate)));
  } catch {
    container.textContent = t('recommendations.loadFailed');
  }
}
