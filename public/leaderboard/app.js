// Leaderboard page: pages through /api/leaderboard. The game opens this page with ?player=<browserId> so the
// player's own row is highlighted and their place is shown at the top.
(() => {
  const PAGE_SIZE = 25;
  const REFRESH_MS = 30_000;

  const params = new URLSearchParams(location.search);
  let playerId = params.get('player');
  if (playerId && /^[A-Za-z0-9-]{8,64}$/.test(playerId)) {
    try { localStorage.setItem('cca_player_id', playerId); } catch { /* storage blocked */ }
    // Keep the id out of the address bar (and out of shared links).
    history.replaceState(null, '', location.pathname);
  } else {
    try { playerId = localStorage.getItem('cca_player_id'); } catch { playerId = null; }
  }

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');
  const statusEl = $('status');
  const searchEl = $('search');
  let offset = 0;
  let matched = 0;
  let query = '';
  let loading = false;
  let searchTimer = 0;

  function fmtTime(seconds) {
    if (seconds == null) return null;
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderRow(entry, index) {
    const row = el('div', 'row' + (entry.isYou ? ' is-you' : ''));
    row.setAttribute('role', 'row');
    row.style.animationDelay = `${Math.min(index, 20) * 25}ms`;

    const rankCell = el('span');
    rankCell.append(el('span', `rank${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`, String(entry.rank)));
    const name = el('span', 'name', entry.name);
    name.title = entry.name;
    if (entry.isYou) name.append(el('span', 'you-tag', 'YOU'));
    const score = el('span', 'num score', entry.bestScore.toLocaleString());
    const t = fmtTime(entry.bestTime);
    const time = el('span', 'num time' + (t ? '' : ' none'), t || '-');
    const runs = el('span', 'num runs hide-sm', String(entry.runs));
    for (const c of [rankCell, name, score, time, runs]) c.setAttribute('role', 'cell');
    row.append(rankCell, name, score, time, runs);
    return row;
  }

  function renderYou(you, total) {
    const box = $('you');
    if (!you) { box.hidden = true; return; }
    box.hidden = false;
    const line = $('you-line');
    if (you.rank > 0) {
      const t = fmtTime(you.bestTime);
      line.textContent = `#${you.rank} of ${total}  -  ${you.name}  -  ${you.bestScore.toLocaleString()} pts` + (t ? `  -  best clean set ${t}` : '');
    } else {
      line.textContent = `${you.name}  -  finish a take to get on the board!`;
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    $('refresh').disabled = true;
    try {
      const url = new URL('/api/leaderboard', location.origin);
      url.searchParams.set('limit', PAGE_SIZE);
      url.searchParams.set('offset', offset);
      if (query) url.searchParams.set('q', query);
      if (playerId) url.searchParams.set('player', playerId);
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'error');

      matched = data.matched;
      rowsEl.replaceChildren(...data.entries.map(renderRow));
      statusEl.textContent = data.entries.length ? '' : (query ? 'No Rookie by that name.' : 'Nobody has wrapped a take yet. Be the first!');
      renderYou(data.you, data.total);

      $('stat-players').textContent = data.total.toLocaleString();
      $('stat-top').textContent = data.topScore == null ? '-' : data.topScore.toLocaleString();
      $('stat-fastest').textContent = fmtTime(data.fastestTime) || '-';
      const pages = Math.max(1, Math.ceil(matched / PAGE_SIZE));
      $('page').textContent = `Page ${Math.floor(offset / PAGE_SIZE) + 1} of ${pages}`;
      $('prev').disabled = offset === 0;
      $('next').disabled = offset + PAGE_SIZE >= matched;
    } catch (err) {
      statusEl.textContent = 'The leaderboard is on a coffee break. Try again in a moment.';
      console.error(err);
    } finally {
      loading = false;
      $('refresh').disabled = false;
    }
  }


  $('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
  $('next').addEventListener('click', () => { offset += PAGE_SIZE; load(); });
  $('refresh').addEventListener('click', () => { load(); });
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value.trim(); offset = 0; load(); }, 250);
  });

  load();
  setInterval(() => { if (!document.hidden) { load(); } }, REFRESH_MS);
})();
