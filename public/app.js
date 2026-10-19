'use strict';
/* gamz client — vanilla JS single-page app (hash routing), live via Server-Sent Events. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const S = { me: null, signup: true, games: [], gameById: {}, pointsTable: [], view: null, live: false };

/* ---------- icons ---------- */
const sv = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${p}</svg>`;
const ICONS = {
  home: sv('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>'),
  trophy: sv('<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H4.5a3 3 0 0 0 3.5 4"/><path d="M16 6h3.5a3 3 0 0 1-3.5 4"/><path d="M12 13v4"/><path d="M8 21h8"/><path d="M9.5 17h5l.5 4h-6z"/>'),
  chart: sv('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  shuffle: sv('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>'),
  user: sv('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  sun: sv('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: sv('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  shield: sv('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  cpu: sv('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>'),
  arrow: sv('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  up: sv('<path d="m6 15 6-6 6 6"/>'), down: sv('<path d="m6 9 6 6 6-6"/>'), x: sv('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: sv('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), spark: sv('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  efootball: sv('<circle cx="12" cy="12" r="9"/><path d="m12 7 4 3-1.5 4.5h-5L8 10z"/><path d="M12 3v4M21 10l-5 0M3 10h5M15 20l-.5-5.5M9 20l.5-5.5"/>'),
  dls: sv('<circle cx="12" cy="12" r="9"/><path d="m12 6.5 1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z"/>'),
  pubgm: sv('<path d="M3 11a9 7 0 0 1 18 0z"/><path d="M3 11l9 9 9-9"/><path d="M12 11v9M7.5 11 12 20M16.5 11 12 20"/>'),
  codm: sv('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/>'),
};
const icon = n => ICONS[n] || '';
$$('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon); });

/* ---------- helpers ---------- */
async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: {}, ...opts };
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, o); let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}
function toast(msg, err = false) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.innerHTML = (err ? '⚠️ ' : '<span class="ok-dot"></span>') + esc(msg);
  $('#toasts').append(t); setTimeout(() => { t.style.transition = 'opacity .5s'; t.style.opacity = 0; setTimeout(() => t.remove(), 500); }, 3200);
}
const FORMAT = { single_elim: 'Single elimination', double_elim: 'Double elimination', league: 'League', league_knockout: 'League + knockout', br_points: 'Battle royale · points' };
const MODE = { '1v1': '1v1', solo: 'Solo', duo: 'Duo', squad: 'Squad', '5v5': '5v5' };
const STATUS = { live: 'Live', registration: 'Registration open', completed: 'Completed', draft: 'Draft' };
const game = id => S.gameById[id] || { id, name: id, short_name: id };
const gameTag = id => `<span class="game-tag g-${esc(id)}">${icon(id)}${esc(game(id).short_name)}</span>`;
const badge = st => `<span class="badge ${esc(st)}">${st === 'completed' ? '✓ ' : ''}${esc(STATUS[st] || st)}</span>`;
const initials = n => esc(String(n || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+|(?=[A-Z])/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?');
const avatar = (name, hue = 260, team = false, cls = '') => `<span class="avatar ${team ? 'team' : ''} ${cls}" style="--h:${+hue || 260}">${initials(name)}</span>`;
// SQLite datetime('now') is UTC without a zone ("YYYY-MM-DD HH:MM:SS"); starts_at is a local wall time ("YYYY-MM-DDTHH:MM").
const utc = s => { if (!s) return null; s = String(s); return s.includes(' ') ? new Date(s.replace(' ', 'T') + 'Z') : new Date(s); };
const fmtDate = s => { if (!s) return ''; const d = utc(s); return isNaN(d) ? esc(s) : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + (String(s).includes('T') ? ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''); };
const ago = s => { const d = utc(s); if (!d || isNaN(d)) return ''; const m = Math.round((Date.now() - d) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const isStaff = () => S.me && (S.me.role === 'admin' || S.me.role === 'organizer');
const isTeamMode = t => !['1v1', 'solo'].includes(t.mode);
const profileLink = p => p.player_id ? `#/p/${p.player_id}` : `#/team/${p.team_id}`;
const empty = (msg, ic = 'spark') => `<div class="empty">${icon(ic)}<div>${msg}</div></div>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : (w.endsWith('ch') ? 'es' : 's')}`;

/* ---------- theme ---------- */
const currentTheme = () => document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('meta[name=theme-color]').setAttribute('content', t === 'light' ? '#f6f4fe' : '#07060d');
  const b = $('#themeBtn'); b.innerHTML = icon(t === 'light' ? 'moon' : 'sun'); b.setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode'); b.title = b.getAttribute('aria-label');
  $$('.theme-switch button').forEach(x => x.classList.toggle('on', x.dataset.theme === t));
}
function setTheme(t) {
  try { localStorage.setItem('gamz-theme', t); } catch {}
  applyTheme(t);
  if (S.me) api('/api/me', { method: 'PUT', body: { theme: t } }).then(r => { S.me = r.user; }).catch(() => {});
}
$('#themeBtn').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
const themeSwitch = () => `<div class="theme-switch" role="group" aria-label="Theme"><button type="button" data-theme="dark" class="${currentTheme() === 'dark' ? 'on' : ''}">${icon('moon')}Dark</button><button type="button" data-theme="light" class="${currentTheme() === 'light' ? 'on' : ''}">${icon('sun')}Light</button></div>`;
document.addEventListener('click', e => { const b = e.target.closest('.theme-switch button'); if (b) setTheme(b.dataset.theme); });
applyTheme(currentTheme());

/* ---------- modal ---------- */
function openModal(html, onMount) {
  $('#modalBody').innerHTML = html; $('#modal').hidden = false; document.body.style.overflow = 'hidden';
  if (onMount) onMount($('#modalBody'));
}
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; document.body.style.overflow = ''; }
$('#modal').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

/* ---------- live updates (SSE) ---------- */
let es, liveTimer;
function connectLive() {
  if (!window.EventSource) return;
  es = new EventSource('/api/stream');
  es.addEventListener('hello', () => setLive(true));
  es.addEventListener('update', e => {
    let d = {}; try { d = JSON.parse(e.data); } catch {}
    clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (S.view && S.view.onUpdate) S.view.onUpdate(d); }, 250);
  });
  es.onerror = () => setLive(false);
  es.onopen = () => setLive(true);
}
function setLive(on) { S.live = on; $('#livePill').classList.toggle('on', on); $('#livePill span').textContent = on ? 'Live' : 'Offline'; }

/* ---------- router ---------- */
const routes = [];
const route = (re, fn, nav) => routes.push({ re, fn, nav });
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/'; const [p, q = ''] = h.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q)) };
}
let renderSeq = 0;
async function render() {
  const { path, query } = parseHash(), seq = ++renderSeq;
  for (const r of routes) {
    const m = path.match(r.re); if (!m) continue;
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r.nav));
    if (S.view && S.view.destroy) S.view.destroy();
    S.view = null; closeModal();
    app.innerHTML = '<div class="stack"><div class="skeleton"></div><div class="skeleton" style="height:200px"></div></div>';
    try {
      const v = await r.fn(m.slice(1), query);
      if (seq !== renderSeq) { if (v && v.destroy) v.destroy(); return; }
      S.view = v || null;
    } catch (e) {
      if (seq !== renderSeq) return;
      const auth = e.status === 401 || e.status === 403;
      app.innerHTML = `<div class="view card">${empty(esc(auth ? 'Please log in with an organizer account to see this page.' : e.message))}${auth ? '<div style="text-align:center"><a class="btn primary" href="#/me">Log in</a></div>' : ''}</div>`;
    }
    window.scrollTo({ top: 0 });
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', render);
const view = html => { app.innerHTML = `<div class="view">${html}</div>`; return app.firstElementChild; };
function setQuery(q) { const { path } = parseHash(); const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '')).toString(); history.replaceState(null, '', '#' + path + (s ? '?' + s : '')); }

/* ---------- shared renderers ---------- */
function tCard(t) {
  const pct = t.matches_total ? Math.round(t.matches_done / t.matches_total * 100) : 0;
  return `<a class="card t-card g-${esc(t.game_id)}" href="#/t/${t.id}">
    <div class="row">${gameTag(t.game_id)}<span class="right">${badge(t.status)}</span></div>
    <h3>${esc(t.name)}</h3>
    <div class="meta"><span>${esc(FORMAT[t.format])}</span><span>${esc(MODE[t.mode] || t.mode)}${t.best_of > 1 && t.format !== 'br_points' ? ' · Bo' + t.best_of : ''}</span><span>${plural(t.participant_count, isTeamMode(t) ? 'team' : 'player')}</span>${t.starts_at ? `<span>${fmtDate(t.starts_at)}</span>` : ''}</div>
    ${t.champion ? `<div class="small" style="margin-top:8px">🏆 <b>${esc(t.champion)}</b></div>` : t.matches_total ? `<div class="progress" aria-label="${pct}% played"><i style="width:${pct}%"></i></div>` : ''}
    ${t.is_example ? '<div style="margin-top:10px"><span class="badge example">Example data</span></div>' : ''}
  </a>`;
}
function resultRow(m) {
  const hw = m.winner_id && m.winner_id === m.home_id, aw = m.winner_id && m.winner_id === m.away_id;
  const pens = m.home_pens != null ? `<div class="tiny dim" style="text-align:center">pens ${m.home_pens}–${m.away_pens}</div>` : '';
  return `<a class="list-row result-row g-${esc(m.game_id)}" href="#/t/${m.tournament_id}">
    <div class="side ${hw ? 'w' : ''} ellipsis">${esc(m.home_name)}</div>
    <div><div class="score-pill num">${m.home_score} – ${m.away_score}</div>${pens}</div>
    <div class="side r ${aw ? 'w' : ''} ellipsis">${esc(m.away_name)}</div></a>`;
}

/* ===================== HOME ===================== */
route(/^\/$/, async () => {
  const draw = async () => {
    const d = await api('/api/overview');
    view(`
      <section class="card hero">
        <div class="eyebrow">gamz · mobile esports community</div>
        <h1>Play together.<br><span>Climb together.</span></h1>
        <p>Tournaments, live brackets and leaderboards for eFootball, DLS, PUBG Mobile and Call of Duty: Mobile.</p>
        <div class="row wrap"><a class="btn primary" href="#/tournaments">${icon('trophy')}Tournaments</a><a class="btn" href="#/leaderboard">${icon('chart')}Leaderboard</a></div>
        <div class="stats">
          <div class="stat"><b>${d.counts.live}</b><span>Live now</span></div><div class="stat"><b>${d.counts.tournaments}</b><span>Events</span></div>
          <div class="stat"><b>${d.counts.players}</b><span>Players</span></div><div class="stat"><b>${d.counts.matches_played}</b><span>Matches</span></div>
        </div>
      </section>
      ${d.example ? `<div class="notice" style="margin-top:14px"><span style="color:var(--purple);flex:none;width:18px">${icon('spark')}</span><div>You're looking at <b>example data</b> (made-up players and results) so you can see how gamz works. An admin can remove it from the System page.</div></div>` : ''}
      <div class="section-title"><h2>Live & upcoming</h2><a href="#/tournaments">See all</a></div>
      ${d.live.length ? `<div class="hscroll">${d.live.map(tCard).join('')}</div>` : `<div class="card">${empty('No live tournaments right now.')}</div>`}
      <div class="section-title"><h2>Games</h2></div>
      <div class="grid2">${S.games.map(g => `<a class="card game-tile g-${g.id}" href="#/tournaments?game=${g.id}"><div class="gicon">${icon(g.id)}</div><div><h3>${esc(g.name)}</h3><div class="tiny">${plural(g.tournament_count, 'tournament')}${g.live_count ? ` · <span style="color:var(--live)">${g.live_count} live</span>` : ''}</div></div></a>`).join('')}</div>
      <div class="cols">
        <div><div class="section-title"><h2>Top of gamz</h2><a href="#/leaderboard">Full ranking</a></div>
          <div class="card pad-0 list">${d.top.length ? d.top.map(r => `<a class="list-row" href="#/p/${r.id}"><span class="rank r${r.rank}">${r.rank}</span>${avatar(r.name, r.avatar_hue)}<div class="grow"><div style="font-weight:600" class="ellipsis">${esc(r.name)}</div><div class="tiny dim">${plural(r.titles, 'title')} · ${plural(r.wins, 'win')}</div></div><span class="score-pill num">${r.points}</span></a>`).join('') : empty('No results yet.')}</div></div>
        <div><div class="section-title"><h2>Latest results</h2></div>
          <div class="card pad-0 list">${d.recent.length ? d.recent.map(resultRow).join('') : empty('No results yet.')}</div></div>
      </div>
      ${d.completed.length ? `<div class="section-title"><h2>Recently completed</h2></div><div class="hscroll">${d.completed.map(tCard).join('')}</div>` : ''}`);
  };
  await draw();
  return { onUpdate: async () => { const y = scrollY; await draw(); scrollTo(0, y); } };
}, 'home');

/* ===================== TOURNAMENT LIST ===================== */
route(/^\/tournaments$/, async (_, q) => {
  let gameF = q.game || '', statusF = q.status || '';
  const draw = async () => {
    const list = await api('/api/tournaments?' + new URLSearchParams({ ...(gameF && { game: gameF }), ...(statusF && { status: statusF }) }));
    view(`<div class="row" style="margin:4px 2px 14px"><h1 style="font-size:26px">Tournaments</h1>${isStaff() ? `<a class="btn sm primary right" href="#/admin?new=1">${icon('plus')}New</a>` : ''}</div>
      <div class="chips"><button class="chip ${!gameF ? 'on' : ''}" data-g="">All games</button>${S.games.map(g => `<button class="chip g-${g.id} ${gameF === g.id ? 'on' : ''}" data-g="${g.id}"><span class="dot"></span>${esc(g.short_name)}</button>`).join('')}</div>
      <div class="chips" style="margin-top:4px">${[['', 'Any status'], ['live', 'Live'], ['registration', 'Registration'], ['completed', 'Completed']].map(([k, l]) => `<button class="chip ${statusF === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
      <div class="stack" style="margin-top:12px">${list.length ? list.map(tCard).join('') : `<div class="card">${empty('No tournaments match these filters.')}</div>`}</div>`);
    $$('[data-g]').forEach(b => b.onclick = () => { gameF = b.dataset.g; setQuery({ game: gameF, status: statusF }); draw(); });
    $$('[data-s]').forEach(b => b.onclick = () => { statusF = b.dataset.s; setQuery({ game: gameF, status: statusF }); draw(); });
  };
  await draw();
  return { onUpdate: () => draw() };
}, 'tournaments');

/* ===================== BRACKET ===================== */
function nameMap(d) { return new Map(d.participants.map(p => [p.id, p])); }
const bracketStages = t => t.format === 'double_elim' ? ['winners', 'losers', 'grand_final'] : ['winners'];
function bracketHTML(d, stages, flashId) {
  const P = nameMap(d), ms = d.matches.filter(m => stages.includes(m.stage) || (stages.includes('grand_final') && m.stage === 'grand_final_reset'));
  if (!ms.length) return '';
  const sections = [];
  if (stages.includes('winners')) sections.push({ title: d.tournament.format === 'double_elim' ? 'Winners bracket' : '', ms: ms.filter(m => m.stage === 'winners') });
  if (stages.includes('losers')) sections.push({ title: 'Losers bracket', ms: ms.filter(m => m.stage === 'losers') });
  if (stages.includes('grand_final')) sections.push({ title: 'Grand final', ms: ms.filter(m => m.stage === 'grand_final' || (m.stage === 'grand_final_reset' && m.status !== 'void')) });
  const W = 188, H = 61, VG = 14, CG = 40, TOP = 26;
  return sections.filter(s => s.ms.length).map(sec => {
    const rk = m => m.stage === 'grand_final_reset' ? 2 : m.round;
    const rounds = [...new Set(sec.ms.map(rk))].sort((a, b) => a - b);
    const col = new Map(rounds.map((r, i) => [r, i])), pos = new Map(), ids = new Set(sec.ms.map(m => m.id));
    for (const r of rounds) {
      sec.ms.filter(m => rk(m) === r).sort((a, b) => a.position - b.position).forEach((m, i) => {
        const f = sec.ms.filter(x => x.next_match_id === m.id && pos.has(x.id));
        const y = f.length ? f.reduce((s, x) => s + pos.get(x.id).y, 0) / f.length : TOP + i * (H + VG);
        pos.set(m.id, { x: col.get(r) * (W + CG), y });
      });
    }
    const width = rounds.length * (W + CG) - CG, height = Math.max(...[...pos.values()].map(p => p.y)) + H + 4;
    const lines = [];
    for (const m of sec.ms) {
      let tgt = m.next_match_id && ids.has(m.next_match_id) ? m.next_match_id : null;
      if (m.stage === 'grand_final') { const r = sec.ms.find(x => x.stage === 'grand_final_reset'); if (r) tgt = r.id; }
      if (!tgt) continue;
      const a = pos.get(m.id), b = pos.get(tgt), x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = x1 + CG / 2;
      lines.push(`<path class="${m.status === 'completed' || m.status === 'bye' ? 'done' : ''}" d="M${x1} ${y1} H${mx} V${y2} H${x2}"/>`);
    }
    const labels = rounds.map(r => { const m = sec.ms.find(x => rk(x) === r); return `<div class="round-label" style="left:${col.get(r) * (W + CG)}px;width:${W}px">${esc(m.label)}</div>`; }).join('');
    const cards = sec.ms.map(m => {
      const p = pos.get(m.id), r = m.result;
      const slot = side => {
        const pid = m[side + '_id'], part = P.get(pid);
        const isBye = !pid && (m.status === 'bye' || m.status === 'void' || (m.stage === 'winners' && m.round === 1));
        const cls = pid ? (m.winner_id ? (m.winner_id === pid ? 'win' : 'lose') : '') : 'tbd';
        const sc = r ? (side === 'home' ? r.home_score : r.away_score) : '';
        const pk = r && r.home_pens != null ? `<span class="pk">(${side === 'home' ? r.home_pens : r.away_pens})</span>` : '';
        return `<div class="slot ${cls}"><span class="sd">${part && part.seed && m.stage === 'winners' && m.round === 1 ? part.seed : ''}</span><span class="nm">${part ? esc(part.name) : isBye ? 'bye' : 'TBD'}</span><span class="sc num">${sc}${pk}</span></div>`;
      };
      return `<div class="match ${m.status} ${m.id === flashId ? 'flash' : ''}" data-mid="${m.id}" style="left:${p.x}px;top:${p.y}px" role="button" tabindex="0" aria-label="${esc(m.label)}">${slot('home')}${slot('away')}</div>`;
    }).join('');
    return `<div class="bracket-section">${sec.title ? `<h3>${sec.title}</h3>` : ''}<div class="bracket-scroll"><div class="bracket" style="width:${width}px;height:${height}px">${labels}<svg class="lines" width="${width}" height="${height}">${lines.join('')}</svg>${cards}</div></div></div>`;
  }).join('');
}

/* ===================== TOURNAMENT DETAIL ===================== */
function tabsFor(t) {
  if (t.format === 'br_points') return [['standings', 'Standings'], ['matches', 'Matches'], ['entrants', isTeamMode(t) ? 'Teams' : 'Players']];
  if (t.format === 'league') return [['table', 'Table'], ['matches', 'Matches'], ['entrants', 'Players']];
  if (t.format === 'league_knockout') return [['table', 'Groups'], ['bracket', 'Knockout'], ['matches', 'Matches'], ['entrants', 'Players']];
  return [['bracket', 'Bracket'], ['matches', 'Matches'], ['entrants', isTeamMode(t) ? 'Teams' : 'Players']];
}
function tHeader(d) {
  const t = d.tournament, champ = t.status === 'completed' && d.participants.find(p => p.rank === 1);
  return `<section class="card t-head g-${esc(t.game_id)}">
    <div class="row wrap">${gameTag(t.game_id)}<span class="right row" style="gap:6px">${t.is_example ? '<span class="badge example">Example</span>' : ''}${badge(t.status)}</span></div>
    <h1>${esc(t.name)}</h1>
    ${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ''}
    <div class="kv"><span>${esc(FORMAT[t.format])}</span><span><b>${esc(MODE[t.mode] || t.mode)}</b></span>${t.family === 'team_shooter' && t.format !== 'br_points' ? `<span>Best of <b>${t.best_of}</b></span>` : ''}${t.format === 'br_points' ? `<span><b>${t.br_match_count}</b> matches</span><span><b>${t.kill_points}</b> pt / kill</span>` : ''}<span><b>${d.participants.length}</b> ${isTeamMode(t) ? 'teams' : 'players'}</span>${t.prize ? `<span>Prize <b>${esc(t.prize)}</b></span>` : ''}${t.starts_at ? `<span>${fmtDate(t.starts_at)}</span>` : ''}</div>
    ${champ ? `<a class="champ" href="${profileLink(champ)}"><span class="tro">${icon('trophy')}</span><div><div class="tiny dim">Champion</div><div style="font:700 17px 'Space Grotesk'">${esc(champ.name)}</div></div></a>` : ''}
    ${isStaff() ? `<div style="margin-top:14px"><a class="btn sm" href="#/admin/t/${t.id}">${icon('edit')}Manage & enter results</a></div>` : ''}
  </section>`;
}
function leagueTables(d) {
  const t = d.tournament, adv = t.format === 'league_knockout' ? t.advance_per_group : 0;
  if (!d.standings.groups.length) return `<div class="card">${empty('Fixtures appear once the organizer generates the league.')}</div>`;
  return d.standings.groups.map(g => `<div class="card pad-0" style="margin-top:12px">${g.label ? `<div style="padding:12px 16px 0" class="row"><h3 style="font-size:15px">${esc(g.label)}</h3>${adv ? `<span class="tiny dim right">Top ${adv} advance</span>` : ''}</div>` : ''}
    <div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th class="l">Player</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th><th class="l">Form</th></tr></thead><tbody>
    ${g.table.map((s, i) => { const p = d.participants.find(x => x.id === s.participant_id); return `<tr class="${i < adv ? 'qual' : ''} ${i === 0 ? 'top' : ''}"><td><span class="rank r${i + 1}">${i + 1}</span></td><td class="name"><a href="${profileLink(p)}">${avatar(s.name, p.avatar_hue)}<span class="ellipsis">${esc(s.name)}</span></a></td><td>${s.P}</td><td>${s.W}</td><td>${s.D}</td><td>${s.L}</td><td>${s.GD > 0 ? '+' : ''}${s.GD}</td><td class="total">${s.Pts}</td><td class="l"><span class="form-dots">${s.form.map(f => `<i class="${f}">${f}</i>`).join('')}</span></td></tr>`; }).join('')}
    </tbody></table></div></div>`).join('') + `<p class="tiny dim" style="margin:10px 4px">Win 3 · Draw 1 · Loss 0. Ties broken by goal difference, then goals scored.${adv ? ' Highlighted rows qualify.' : ''}</p>`;
}
function brTable(d, flashSet = new Set()) {
  const brm = d.matches.filter(m => m.stage === 'br');
  if (!d.standings.br.length) return `<div class="card">${empty('No teams registered yet.')}</div>`;
  const P = nameMap(d), played = brm.filter(m => m.status === 'completed').length;
  return `<div class="row" style="margin:0 4px 10px"><span class="small muted">${played} of ${brm.length} matches played</span><span class="tiny dim right">🍗 = chicken dinners</span></div>
    <div class="card pad-0"><div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th class="l">${isTeamMode(d.tournament) ? 'Team' : 'Player'}</th><th>Total</th><th title="Chicken dinners">🍗</th><th>Kills</th><th>Place</th>${brm.map(m => `<th title="${esc(m.map_name || '')}">M${m.round}</th>`).join('')}</tr></thead><tbody>
    ${d.standings.br.map((s, i) => { const p = P.get(s.participant_id); return `<tr class="${i < 3 && s.played ? 'top' : ''} ${flashSet.has(s.participant_id) ? 'flash' : ''}"><td><span class="rank r${s.played ? i + 1 : 0}">${i + 1}</span></td><td class="name"><a href="${profileLink(p)}">${avatar(s.name, p.avatar_hue, !!p.team_id)}<span class="ellipsis">${esc(s.name)}</span></a></td><td class="total">${s.total}</td><td>${s.wwcd}</td><td>${s.kills}</td><td>${s.placement_points}</td>${brm.map(m => { const pm = s.per_match[m.id]; return `<td>${pm ? `<span class="mchip ${pm.placement === 1 ? 'dinner' : ''}" title="#${pm.placement}, ${pm.kills} kills">${pm.points}</span>` : '<span class="dim">–</span>'}</td>`; }).join('')}</tr>`; }).join('')}
    </tbody></table></div></div>
    <details class="explain" style="margin-top:12px"><summary>How BR points work</summary>
      <ul><li>Points per match = placement points + ${d.tournament.kill_points} × kills.</li><li>Placement points: ${(d.tournament.points_table ? JSON.parse(d.tournament.points_table) : S.pointsTable).map((p, i) => `#${i + 1}: ${p}`).join(', ')}; lower places 0.</li><li>Ties: total points → chicken dinners → placement points → kills → best last-match placement.</li></ul></details>`;
}
function matchesList(d) {
  const P = nameMap(d);
  if (!d.matches.length) return `<div class="card">${empty('Matches appear once the organizer generates the bracket.')}</div>`;
  const groups = []; let cur = null;
  for (const m of d.matches) { if (m.status === 'void') continue; const key = m.stage + (m.group_label || '') + m.round; if (!cur || cur.key !== key) { cur = { key, title: (m.group_label ? m.group_label + ' · ' : '') + m.label, ms: [] }; groups.push(cur); } cur.ms.push(m); }
  return groups.map(g => `<div class="section-title" style="margin-top:16px"><h2 style="font-size:15px">${esc(g.title)}</h2></div><div class="card pad-0 list">${g.ms.map(m => {
    if (m.stage === 'br') { const top = (m.br || []).slice(0, 3).map(r => esc(P.get(r.participant_id)?.name)).join(' · '); return `<div class="list-row" data-mid="${m.id}" style="cursor:pointer"><div class="grow"><div style="font-weight:600">${esc(m.map_name || '')}</div><div class="tiny dim ellipsis">${m.status === 'completed' ? '🍗 ' + top : 'Not played yet'}</div></div>${m.status === 'completed' ? '<span class="badge completed">✓ Played</span>' : '<span class="badge registration">Upcoming</span>'}</div>`; }
    const h = P.get(m.home_id), a = P.get(m.away_id), r = m.result;
    if (m.status === 'bye') return `<div class="list-row"><div class="grow dim small">${esc((h || a)?.name || '—')} — bye, advances</div></div>`;
    return `<div class="list-row result-row" data-mid="${m.id}" style="cursor:pointer"><div class="side ${m.winner_id && m.winner_id === m.home_id ? 'w' : ''} ellipsis">${esc(h?.name || 'TBD')}</div><div style="text-align:center">${r ? `<div class="score-pill num">${r.home_score} – ${r.away_score}</div>${r.home_pens != null ? `<div class="tiny dim">pens ${r.home_pens}–${r.away_pens}</div>` : ''}` : `<span class="badge ${m.status === 'ready' ? 'live' : 'draft'}">${m.status === 'ready' ? 'Up next' : 'Waiting'}</span>`}</div><div class="side r ${m.winner_id && m.winner_id === m.away_id ? 'w' : ''} ellipsis">${esc(a?.name || 'TBD')}</div></div>`;
  }).join('')}</div>`).join('');
}
function entrantsList(d) {
  const ps = [...d.participants].sort((a, b) => (a.rank || 999) - (b.rank || 999) || (a.seed || 999) - (b.seed || 999));
  if (!ps.length) return `<div class="card">${empty('No one registered yet.')}</div>`;
  return `<div class="card pad-0 list">${ps.map(p => `<a class="list-row" href="${profileLink(p)}"><span class="rank ${p.rank ? 'r' + p.rank : ''}">${p.rank || p.seed || ''}</span>${avatar(p.name, p.avatar_hue, !!p.team_id)}<div class="grow"><div style="font-weight:600" class="ellipsis">${esc(p.name)}</div><div class="tiny dim">${p.seed ? 'Seed ' + p.seed : ''}${p.group_label ? ' · ' + esc(p.group_label) : ''}${p.rank ? ' · Finished #' + p.rank : ''}</div></div><span style="color:var(--dim);width:16px">${icon('arrow')}</span></a>`).join('')}</div>`;
}
const canEdit = m => m.stage === 'br' || (m.home_id && m.away_id && ['ready', 'completed'].includes(m.status));
function matchDetail(d, mid) {
  const m = d.matches.find(x => x.id === mid); if (!m) return;
  if (isStaff() && canEdit(m)) return openResultForm(d, m);
  const P = nameMap(d), h = P.get(m.home_id), a = P.get(m.away_id), r = m.result;
  if (m.stage === 'br') {
    return openModal(`<h2>${esc(m.label)} · ${esc(m.map_name || '')}</h2><div class="small dim">${m.status === 'completed' ? 'Final placements' : 'Not played yet'}</div>
      ${(m.br || []).length ? `<div class="table-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>#</th><th class="l">${isTeamMode(d.tournament) ? 'Team' : 'Player'}</th><th>Kills</th></tr></thead><tbody>${m.br.map(x => `<tr><td>${x.placement}</td><td class="l">${esc(P.get(x.participant_id)?.name)}</td><td>${x.kills}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
  }
  openModal(`<div class="eyebrow">${esc(m.label)}</div><h2 style="margin-top:4px">${esc(h?.name || 'TBD')} <span class="dim">vs</span> ${esc(a?.name || 'TBD')}</h2>
    <div style="margin:18px 0;text-align:center">${r ? `<div class="display" style="font-size:42px;font-weight:700">${r.home_score} – ${r.away_score}</div>${r.home_pens != null ? `<div class="muted">Penalties ${r.home_pens}–${r.away_pens}</div>` : ''}${m.best_of > 1 ? `<div class="tiny dim">Best of ${m.best_of} (maps won)</div>` : ''}${r.detail ? `<div class="small muted" style="margin-top:8px">${esc(r.detail)}</div>` : ''}` : `<span class="badge ${m.status === 'ready' ? 'live' : 'draft'}">${m.status === 'ready' ? 'Up next' : m.status === 'bye' ? 'Bye' : 'Waiting for previous matches'}</span>`}</div>
    ${m.winner_id ? `<div class="champ"><span class="tro">${icon('trophy')}</span><div><div class="tiny dim">Winner</div><b>${esc(P.get(m.winner_id)?.name)}</b></div></div>` : ''}`);
}

route(/^\/t\/(\d+)$/, async ([id], q) => {
  let d = await api('/api/tournaments/' + id), tab = q.tab, flash = null, flashBr = new Set();
  const tabs = tabsFor(d.tournament); if (!tabs.some(x => x[0] === tab)) tab = tabs[0][0];
  const body = () => {
    if (tab === 'bracket') {
      const t = d.tournament, b = bracketHTML(d, bracketStages(t), flash);
      return b ? `<div class="card" style="padding:12px 12px 6px">${b}<div class="legend"><span><i class="lr"></i>Up next</span><span><i class="lw"></i>Winner</span><span><i class="lb"></i>Bye</span><span>Swipe sideways →</span></div></div>` : `<div class="card">${empty(t.format === 'league_knockout' ? 'The knockout bracket is drawn when the group stage ends.' : 'The bracket is drawn when registration closes.')}</div>`;
    }
    if (tab === 'table') return leagueTables(d);
    if (tab === 'standings') return brTable(d, flashBr);
    if (tab === 'matches') return matchesList(d);
    return entrantsList(d);
  };
  const draw = () => {
    const y = scrollY, sx = $$('.bracket-scroll').map(e => e.scrollLeft);
    view(`${tHeader(d)}<div class="tabs" style="margin:16px 0 4px" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tbody" style="margin-top:12px">${body()}</div>`);
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; setQuery({ tab }); flash = null; draw(); });
    $$('.bracket-scroll').forEach((e, i) => { if (sx[i]) e.scrollLeft = sx[i]; });
    scrollTo(0, y);
  };
  const onClick = e => { const el = e.target.closest('[data-mid]'); if (el) matchDetail(d, +el.dataset.mid); };
  const onKey = e => { if (e.key === 'Enter' && e.target.matches('.match')) e.target.click(); };
  app.addEventListener('click', onClick); app.addEventListener('keydown', onKey);
  draw();
  return {
    destroy: () => { app.removeEventListener('click', onClick); app.removeEventListener('keydown', onKey); },
    onUpdate: async ev => {
      if (ev.tournament_id && ev.tournament_id !== +id) return;
      const before = new Map(d.standings.br.map(s => [s.participant_id, s.rank]));
      d = await api('/api/tournaments/' + id); flash = ev.match_id || null;
      flashBr = new Set(d.standings.br.filter(s => before.get(s.participant_id) !== s.rank).map(s => s.participant_id));
      if ($('#modal').hidden) draw();
    },
    reload: async () => { d = await api('/api/tournaments/' + id); draw(); },
  };
}, 'tournaments');

/* ===================== RESULT ENTRY (organizers) ===================== */
const errBox = m => `<div class="err-box">⚠️ ${esc(m)}</div>`;
function openResultForm(d, m) {
  const P = nameMap(d), t = d.tournament;
  if (m.stage === 'br') return openBrForm(d, m);
  const h = P.get(m.home_id), a = P.get(m.away_id), r = m.result || {}, football = t.family === 'football', ko = m.stage !== 'league';
  const need = Math.floor((m.best_of || 1) / 2) + 1;
  const quick = football ? [] : [...Array(need).keys()].flatMap(l => [[need, l], [l, need]]);
  openModal(`<div class="eyebrow">${esc(m.label)}${m.group_label ? ' · ' + esc(m.group_label) : ''}</div><h2>Enter result</h2>
    <div class="small dim">${football ? 'Goals scored.' + (ko ? ' If it ends level, add the penalty shoot-out.' : ' Draws are allowed in the league.') : `Best of ${m.best_of}: maps won (first to ${need}).`}</div>
    <form class="form" id="rf">
      <div class="vs-entry">
        <div class="who"><div class="ellipsis">${esc(h.name)}</div><div class="stepper"><button type="button" data-st="hs" data-d="-1" aria-label="minus">−</button><input class="input num" name="home_score" inputmode="numeric" value="${r.home_score ?? 0}" aria-label="${esc(h.name)} score"><button type="button" data-st="hs" data-d="1" aria-label="plus">+</button></div></div>
        <div class="vs">VS</div>
        <div class="who"><div class="ellipsis">${esc(a.name)}</div><div class="stepper"><button type="button" data-st="as" data-d="-1" aria-label="minus">−</button><input class="input num" name="away_score" inputmode="numeric" value="${r.away_score ?? 0}" aria-label="${esc(a.name)} score"><button type="button" data-st="as" data-d="1" aria-label="plus">+</button></div></div>
      </div>
      ${quick.length ? `<div class="quick">${quick.map(([x, y]) => `<button type="button" class="chip ${r.home_score === x && r.away_score === y ? 'on' : ''}" data-q="${x},${y}">${x}–${y}</button>`).join('')}</div>` : ''}
      ${football && ko ? `<div id="pens" class="two" hidden><label class="field">${esc(h.name)} pens<input class="input" name="home_pens" inputmode="numeric" value="${r.home_pens ?? ''}"></label><label class="field">${esc(a.name)} pens<input class="input" name="away_pens" inputmode="numeric" value="${r.away_pens ?? ''}"></label></div>` : ''}
      ${!football ? `<label class="field">Map details <span class="hint">(optional)</span><input class="input" name="detail" placeholder="e.g. Hardpoint 250–180, S&D 6–4" value="${esc(r.detail || '')}"></label>` : ''}
      <div id="rerr"></div>
      <button class="btn primary block" type="submit">Save result</button>
      ${m.status === 'completed' ? '<button class="btn ghost block" type="button" id="clr">Clear this result</button>' : ''}
    </form>`, root => {
    const f = $('#rf', root), pens = $('#pens', root);
    const sync = () => { if (pens) pens.hidden = f.home_score.value !== f.away_score.value; };
    $$('[data-st]', root).forEach(b => b.onclick = () => { const i = b.dataset.st === 'hs' ? f.home_score : f.away_score; i.value = Math.max(0, (+i.value || 0) + +b.dataset.d); sync(); });
    $$('[data-q]', root).forEach(b => b.onclick = () => { const [x, y] = b.dataset.q.split(','); f.home_score.value = x; f.away_score.value = y; $$('[data-q]', root).forEach(c => c.classList.toggle('on', c === b)); });
    f.home_score.oninput = f.away_score.oninput = sync; sync();
    f.onsubmit = async e => {
      e.preventDefault(); const body = Object.fromEntries(new FormData(f)); if (pens && pens.hidden) { delete body.home_pens; delete body.away_pens; }
      try { await api(`/api/matches/${m.id}/result`, { method: 'POST', body }); closeModal(); toast('Result saved — bracket & leaderboard updated'); if (S.view && S.view.reload) S.view.reload(); }
      catch (er) { $('#rerr', root).innerHTML = errBox(er.message); }
    };
    const c = $('#clr', root); if (c) c.onclick = async () => { if (!confirm('Clear this result? Later matches fed by it are reset.')) return; try { await api(`/api/matches/${m.id}/result`, { method: 'DELETE' }); closeModal(); toast('Result cleared'); S.view?.reload?.(); } catch (er) { $('#rerr', root).innerHTML = errBox(er.message); } };
  });
}
function openBrForm(d, m) {
  const t = d.tournament, table = t.points_table ? JSON.parse(t.points_table) : S.pointsTable, kp = t.kill_points;
  const existing = new Map((m.br || []).map(r => [r.participant_id, r]));
  let order = d.standings.br.map(s => d.participants.find(p => p.id === s.participant_id));
  if (existing.size) order.sort((a, b) => (existing.get(a.id)?.placement || 999) - (existing.get(b.id)?.placement || 999));
  openModal(`<div class="eyebrow">${esc(m.label)} · ${esc(m.map_name || '')}</div><h2>Enter BR results</h2>
    <div class="small dim">Placement (1 = chicken dinner) and kills for each ${isTeamMode(t) ? 'team' : 'player'}. Points = placement points + ${kp} × kills.</div>
    <form id="bf" class="form" style="margin-top:12px">
      <div class="table-wrap"><table class="tbl br-entry"><thead><tr><th class="l" colspan="2">${isTeamMode(t) ? 'Team' : 'Player'}</th><th>Place</th><th>Kills</th><th>Pts</th></tr></thead><tbody>
      ${order.map(p => { const e = existing.get(p.id) || {}; return `<tr data-pid="${p.id}"><td colspan="2" class="name l"><span class="ellipsis" style="display:block;max-width:130px;font-weight:600">${esc(p.name)}</span></td><td><input class="input num" inputmode="numeric" name="pl" value="${e.placement ?? ''}" aria-label="${esc(p.name)} placement"></td><td><input class="input num" inputmode="numeric" name="k" value="${e.kills ?? ''}" aria-label="${esc(p.name)} kills"></td><td class="total" data-pts>–</td></tr>`; }).join('')}
      </tbody></table></div>
      <button type="button" class="btn sm ghost" id="autoPl">Number placements 1…${order.length} in this order</button>
      <div id="berr"></div>
      <button class="btn primary block" type="submit">Save results</button>
      ${m.status === 'completed' ? '<button class="btn ghost block" type="button" id="bclr">Clear this match</button>' : ''}
    </form>`, root => {
    const calc = () => $$('tr[data-pid]', root).forEach(tr => { const pl = +tr.querySelector('[name=pl]').value, k = +tr.querySelector('[name=k]').value || 0; tr.querySelector('[data-pts]').textContent = pl ? (table[pl - 1] || 0) + k * kp : '–'; });
    root.addEventListener('input', calc); calc();
    $('#autoPl', root).onclick = () => { $$('tr[data-pid]', root).forEach((tr, i) => { tr.querySelector('[name=pl]').value = i + 1; if (tr.querySelector('[name=k]').value === '') tr.querySelector('[name=k]').value = 0; }); calc(); };
    $('#bf', root).onsubmit = async e => {
      e.preventDefault();
      const rows = $$('tr[data-pid]', root).map(tr => ({ participant_id: +tr.dataset.pid, placement: tr.querySelector('[name=pl]').value, kills: tr.querySelector('[name=k]').value || 0 })).filter(r => r.placement !== '');
      try { await api(`/api/matches/${m.id}/br-result`, { method: 'POST', body: { rows } }); closeModal(); toast('Results saved — standings updated'); S.view?.reload?.(); }
      catch (er) { $('#berr', root).innerHTML = errBox(er.message); }
    };
    const c = $('#bclr', root); if (c) c.onclick = async () => { if (!confirm('Clear all results for this match?')) return; await api(`/api/matches/${m.id}/result`, { method: 'DELETE' }); closeModal(); toast('Match cleared'); S.view?.reload?.(); };
  });
}

/* ===================== LEADERBOARD ===================== */
route(/^\/leaderboard$/, async (_, q) => {
  let g = q.game || 'overall', prev = new Map();
  const cols = gid => {
    if (gid === 'overall') return [['Pts', r => r.points, 'total'], ['Titles', r => r.titles], ['Wins', r => r.wins], ['Kills', r => r.kills], ['Events', r => r.tournaments]];
    const fam = game(gid).family;
    if (fam === 'football') return [['Score', r => r.score, 'total'], ['W-D-L', r => `${r.wins}-${r.draws}-${r.losses}`], ['GD', r => (r.gd > 0 ? '+' : '') + r.gd], ['Titles', r => r.titles], ['Events', r => r.tournaments]];
    if (fam === 'battle_royale') return [['Score', r => r.score, 'total'], ['🍗', r => r.wwcd], ['Kills', r => r.kills], ['BR pts', r => r.br_points], ['Titles', r => r.titles]];
    return [['Score', r => r.score, 'total'], ['W-L', r => `${r.wins}-${r.losses}`], ['Maps', r => `${r.maps_won}-${r.maps_lost}`], ['Kills', r => r.kills], ['Titles', r => r.titles]];
  };
  const draw = async (live = false) => {
    const d = await api('/api/leaderboard?game=' + g), rows = d.rows, c = cols(g), val = r => g === 'overall' ? r.points : r.score;
    const changed = new Set(live ? rows.filter(r => !prev.has(r.key) || prev.get(r.key).rank !== r.rank || val(prev.get(r.key)) !== val(r)).map(r => r.key) : []);
    prev = new Map(rows.map(r => [r.key, r]));
    const link = r => r.type === 'team' ? `#/team/${r.id}` : `#/p/${r.id}`;
    const pod = rows.slice(0, 3), order = [pod[1], pod[0], pod[2]], places = [2, 1, 3];
    const y = scrollY;
    view(`<div class="row" style="margin:4px 2px 14px"><h1 style="font-size:26px">Leaderboard</h1><span class="tiny dim right">${S.live ? '<span class="ok-dot"></span>Updates live' : ''}</span></div>
      <div class="chips"><button class="chip ${g === 'overall' ? 'on' : ''}" data-g="overall">✦ Overall gamz</button>${S.games.map(x => `<button class="chip g-${x.id} ${g === x.id ? 'on' : ''}" data-g="${x.id}"><span class="dot"></span>${esc(x.short_name)}</button>`).join('')}</div>
      ${rows.length >= 3 ? `<div class="podium" style="margin-top:14px">${order.map((r, i) => `<a class="pod p${places[i]}" href="${link(r)}"><span class="place">#${places[i]}</span>${avatar(r.name, r.avatar_hue, r.type === 'team', places[i] === 1 ? 'lg' : '')}<div class="nm ellipsis">${esc(r.name)}</div><div class="pts num">${val(r)}</div></a>`).join('')}</div>` : ''}
      <div class="card pad-0" style="margin-top:14px">${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th class="l">${g === 'overall' ? 'Player' : 'Player / team'}</th>${c.map(x => `<th>${x[0]}</th>`).join('')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="${r.rank <= 3 ? 'top' : ''} ${changed.has(r.key) ? 'flash' : ''}"><td><span class="rank r${r.rank}">${r.rank}</span></td><td class="name"><a href="${link(r)}">${avatar(r.name, r.avatar_hue, r.type === 'team')}<span class="ellipsis">${esc(r.name)}</span>${r.move > 0 ? `<span class="mv up" title="Up ${r.move}">▲${r.move}</span>` : r.move < 0 ? `<span class="mv down" title="Down ${-r.move}">▼${-r.move}</span>` : ''}</a></td>${c.map(x => `<td class="${x[2] || ''}">${esc(x[1](r))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>` : empty('No results yet for this game.')}</div>
      <details class="explain" style="margin-top:14px"><summary>How points are calculated</summary>
        ${g === 'overall' ? `<ul><li><b>gamz points</b> = tournament placement points + 2 per match win + 1 per draw + 2 per BR chicken dinner.</li><li>Placement points (completed tournaments): 1st 100 · 2nd 70 · 3rd 50 · 4th 40 · 5–8th 25 · 9–16th 15 · others 10.</li><li>Team results count for every player on the team. Ties: titles, then wins.</li></ul>`
        : `<ul><li><b>Score</b> = tournament placement points + 3 per win + 1 per draw + battle-royale points (placement + kills).</li><li>Placement points: 1st 100 · 2nd 70 · 3rd 50 · 4th 40 · 5–8th 25 · 9–16th 15 · others 10.</li><li>Ties: titles → wins → goal difference → kills.</li></ul>`}
        <div class="tiny dim">Recomputed from match results every time a result is entered.</div></details>`);
    if (live) scrollTo(0, y);
    $$('[data-g]').forEach(b => b.onclick = () => { g = b.dataset.g; prev = new Map(); setQuery({ game: g }); draw(); });
  };
  await draw();
  return { onUpdate: () => draw(true) };
}, 'leaderboard');

/* ===================== RANDOM PAIRING ===================== */
function seedOrder(n) { let o = [1]; while (o.length < n) { const k = o.length * 2; o = o.flatMap(s => [s, k + 1 - s]); } return o; }
function drawPairs(list) { // same rule as the server's 'as_listed' bracket: byes go to the first entries drawn
  const n = list.length; if (n < 2) return [];
  let S2 = 1; while (S2 < n) S2 *= 2; const o = seedOrder(S2), out = []; let k = 0;
  for (let m = 0; m < S2 / 2; m++) { const bye = o[2 * m] > n || o[2 * m + 1] > n; out.push([list[k++], bye ? null : list[k++]]); }
  return out;
}
const rand = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const shuffleArr = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
route(/^\/pairing$/, async (_, q) => {
  const ts = (await api('/api/tournaments')).filter(t => t.format !== 'br_points' && t.participant_count >= 2);
  let src = q.t || '', names = q.demo ? 'KmerViper\nWouriGhost\nMboaNova\nSanagaBlaze\nKribiWave\nBueaFrost\nLimbeLynx' : '', result = [], detail = null;
  const draw = () => {
    const t = detail && detail.tournament, generated = detail && detail.matches.length > 0;
    view(`<div class="row" style="margin:4px 2px 6px"><h1 style="font-size:26px">Random pairing</h1></div>
      <p class="muted small" style="margin:0 2px 14px">Fair, random 1v1 draws for match nights, using your phone's secure random generator. With an odd number, byes go to the first names drawn.</p>
      <div class="card"><div class="form">
        <label class="field">Who's playing?<select class="input" id="src"><option value="">Type names myself</option>${ts.map(x => `<option value="${x.id}" ${String(x.id) === src ? 'selected' : ''}>${esc(game(x.game_id).short_name)} · ${esc(x.name)}</option>`).join('')}</select></label>
        ${src ? `<div class="small muted">${detail ? plural(detail.participants.length, isTeamMode(t) ? 'team' : 'player') + ' registered.' : ''}${generated ? ' <b>Bracket already drawn</b> — this shuffle is just for fun.' : ''}</div>` : `<label class="field">Names <span class="hint">one per line</span><textarea class="input" id="names" placeholder="KmerViper&#10;WouriGhost&#10;MboaNova&#10;SanagaBlaze">${esc(names)}</textarea></label>`}
        <button class="btn primary block" id="go">${icon('shuffle')}Shuffle & pair</button>
      </div></div>
      <div style="margin-top:16px">${result.length ? `<div class="section-title" style="margin-top:0"><h2>Draw</h2><span class="tiny dim">${plural(result.length, 'match')}</span></div><div class="pair-list">${result.map((p, i) => `<div class="card pair" style="animation-delay:${i * 60}ms"><span class="n">${i + 1}</span><span class="a ellipsis">${esc(p[0].name)}</span>${p[1] ? '<span class="v">VS</span>' : '<span></span>'}<span class="b ellipsis ${p[1] ? '' : 'bye'}">${p[1] ? esc(p[1].name) : 'bye → next round'}</span></div>`).join('')}</div>
        ${src && isStaff() && !generated ? `<button class="btn primary block" id="use" style="margin-top:14px">${icon('trophy')}Use this draw for the bracket</button>` : ''}` : `<div class="card">${empty('Your pairings will appear here.', 'shuffle')}</div>`}</div>`);
    $('#src').onchange = async e => { src = e.target.value; result = []; detail = src ? await api('/api/tournaments/' + src) : null; setQuery({ t: src }); draw(); };
    const nm = $('#names'); if (nm) nm.oninput = e => { names = e.target.value; };
    $('#go').onclick = () => {
      const list = src ? detail.participants.map(p => ({ id: p.id, name: p.name })) : [...new Set(names.split('\n').map(s => s.trim()).filter(Boolean))].map(n => ({ name: n }));
      if (list.length < 2) return toast('Add at least 2 names', true);
      result = drawPairs(shuffleArr(list)); draw();
    };
    const u = $('#use'); if (u) u.onclick = async () => {
      try { await api(`/api/tournaments/${src}/generate`, { method: 'POST', body: { pairing: 'as_listed', order: result.flat().filter(Boolean).map(p => p.id) } }); toast('Bracket generated from this draw'); location.hash = '#/t/' + src; }
      catch (e) { toast(e.message, true); }
    };
  };
  if (src) detail = await api('/api/tournaments/' + src).catch(() => null);
  draw();
  if (q.demo) $('#go').click();
}, 'pairing');

/* ===================== PROFILES ===================== */
function historyList(h) {
  return h.length ? `<div class="card pad-0 list">${h.map(x => `<a class="list-row g-${esc(x.game_id)}" href="#/t/${x.tournament_id}"><div class="grow"><div class="ellipsis" style="font-weight:600">${esc(x.name)}</div><div class="tiny">${gameTag(x.game_id)} <span class="dim">· ${esc(FORMAT[x.format])}</span></div></div>${x.rank && x.status === 'completed' ? `<span class="score-pill">${x.rank === 1 ? '🏆 ' : ''}#${x.rank}</span>` : badge(x.status)}</a>`).join('')}</div>` : `<div class="card">${empty('No tournaments yet.')}</div>`;
}
function recentList(rec) {
  const items = [...(rec.matches || []).map(m => ({ at: m.completed_at, html: resultRow(m) })), ...(rec.br || []).map(b => ({ at: b.completed_at, html: `<a class="list-row g-${esc(b.game_id)}" href="#/t/${b.tournament_id}"><div class="grow"><div class="ellipsis" style="font-weight:600">${esc(b.tournament_name)}</div><div class="tiny dim">${esc(b.label)} · ${esc(b.map_name || '')}</div></div><span class="score-pill">${b.placement === 1 ? '🍗 ' : ''}#${b.placement} · ${b.kills}K</span></a>` }))]
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
  return items.length ? `<div class="card pad-0 list">${items.map(i => i.html).join('')}</div>` : `<div class="card">${empty('No matches played yet.')}</div>`;
}
function statCards(per) {
  return per.length ? `<div class="grid2">${per.map(r => `<div class="card g-${esc(r.game_id)}" style="padding:14px">${gameTag(r.game_id)}<div class="tiny dim ellipsis" style="margin-top:4px">${r.type === 'team' ? 'with ' + esc(r.name) : 'solo'}</div><div style="font:700 24px 'Space Grotesk';margin-top:6px">#${r.rank}</div><div class="tiny muted">${r.score} pts · ${r.wins}W${game(r.game_id).family === 'football' ? ` · GD ${r.gd > 0 ? '+' : ''}${r.gd}` : ''}${r.kills ? ` · ${r.kills} kills` : ''}${r.titles ? ` · 🏆${r.titles}` : ''}</div></div>`).join('')}</div>` : `<div class="card">${empty('No ranked results yet.')}</div>`;
}
route(/^\/p\/(\d+)$/, async ([id]) => {
  const draw = async () => {
    const d = await api('/api/players/' + id), p = d.player, o = d.overall;
    view(`<section class="card hero" style="padding:22px 18px"><div class="row" style="gap:14px">${avatar(p.gamer_tag, p.avatar_hue, false, 'lg')}<div class="grow"><div class="eyebrow">Player${p.is_example ? ' · example' : ''}</div><h1 style="font-size:26px;margin:2px 0" class="ellipsis">${esc(p.gamer_tag)}</h1><div class="small muted">${esc(p.real_name ? p.real_name + ' · ' : '')}${esc(p.country || '')}${p.account ? ' · ✓ gamz account' : ''}</div></div></div>
      ${p.bio ? `<p style="margin:14px 0 0">${esc(p.bio)}</p>` : ''}
      <div class="stats"><div class="stat"><b>${o ? '#' + o.rank : '–'}</b><span>gamz rank</span></div><div class="stat"><b>${o ? o.points : 0}</b><span>Points</span></div><div class="stat"><b>${o ? o.titles : 0}</b><span>Titles</span></div><div class="stat"><b>${o ? o.wins : 0}</b><span>Wins</span></div></div></section>
      ${d.teams.length ? `<div class="section-title"><h2>Teams</h2></div><div class="chips">${d.teams.map(t => `<a class="chip ${t.game_id ? 'g-' + esc(t.game_id) : ''}" href="#/team/${t.id}"><span class="dot"></span>${esc(t.name)}${t.role === 'captain' ? ' · ★' : ''}</a>`).join('')}</div>` : ''}
      <div class="section-title"><h2>Per game</h2></div>${statCards(d.per_game)}
      <div class="cols"><div><div class="section-title"><h2>Tournaments</h2></div>${historyList(d.history)}</div><div><div class="section-title"><h2>Recent matches</h2></div>${recentList(d.recent)}</div></div>`);
  };
  await draw(); return { onUpdate: draw };
}, 'leaderboard');
route(/^\/team\/(\d+)$/, async ([id]) => {
  const draw = async () => {
    const d = await api('/api/teams/' + id), t = d.team;
    view(`<section class="card hero ${t.game_id ? 'g-' + esc(t.game_id) : ''}" style="padding:22px 18px"><div class="row" style="gap:14px">${avatar(t.name, 250, true, 'lg')}<div class="grow"><div class="eyebrow">Team${t.is_example ? ' · example' : ''}</div><h1 style="font-size:26px;margin:2px 0" class="ellipsis">${esc(t.name)}</h1><div class="small">${t.game_id ? gameTag(t.game_id) : ''} ${t.tag ? `<span class="dim">[${esc(t.tag)}]</span>` : ''}</div></div></div></section>
      <div class="section-title"><h2>Roster</h2></div><div class="card pad-0 list">${d.members.length ? d.members.map(m => `<a class="list-row" href="#/p/${m.id}">${avatar(m.gamer_tag, m.avatar_hue)}<div class="grow" style="font-weight:600">${esc(m.gamer_tag)}</div><span class="badge">${m.role === 'captain' ? '★ Captain' : esc(m.role)}</span></a>`).join('') : empty('No members listed.')}</div>
      <div class="section-title"><h2>Per game</h2></div>${statCards(d.per_game)}
      <div class="cols"><div><div class="section-title"><h2>Tournaments</h2></div>${historyList(d.history)}</div><div><div class="section-title"><h2>Recent matches</h2></div>${recentList(d.recent)}</div></div>`);
  };
  await draw(); return { onUpdate: draw };
}, 'leaderboard');

/* ===================== ACCOUNT ===================== */
async function refreshMe() {
  const r = await api('/api/me'); S.me = r.user; S.signup = r.signup;
  if (S.me && S.me.theme && S.me.theme !== currentTheme()) { try { localStorage.setItem('gamz-theme', S.me.theme); } catch {} applyTheme(S.me.theme); }
  $$('.staff-only').forEach(e => { e.hidden = !isStaff(); }); $$('.admin-only').forEach(e => { e.hidden = !(S.me && S.me.role === 'admin'); });
  $('#meBtn').innerHTML = S.me ? `<span style="font:700 14px 'Space Grotesk'">${initials(S.me.username)}</span>` : icon('user');
}
function loginCard() {
  return `<section class="card hero" style="padding:24px 18px"><div class="eyebrow">Welcome back</div><h1 style="font-size:28px">Log in to <span>gamz</span></h1><p>Organizers enter results here. Players can claim a profile and keep their settings in sync.</p>
    <form class="form" id="lf"><label class="field">Username<input class="input" name="username" autocomplete="username" autocapitalize="none" required></label><label class="field">Password<input class="input" type="password" name="password" autocomplete="current-password" required></label><div id="lerr"></div><button class="btn primary block">Log in</button></form>
    ${S.signup ? `<p class="small" style="margin:14px 0 0;text-align:center">New here? <a href="#/signup" style="color:var(--purple);font-weight:600">Create a player account</a></p>` : ''}</section>`;
}
function settingsCard() { return `<div class="card"><div class="row wrap"><div class="grow"><h3 style="font-size:15px">Appearance</h3><div class="tiny dim">Saved on this device${S.me ? ' and on your account' : ''}.</div></div>${themeSwitch()}</div></div>`; }
route(/^\/(me|login)$/, async () => {
  await refreshMe();
  if (!S.me) {
    view(`<div class="stack">${loginCard()}${settingsCard()}</div>`);
    $('#lf').onsubmit = async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); await refreshMe(); toast('Logged in as ' + S.me.username); if (isStaff()) location.hash = '#/admin'; else render(); } catch (er) { $('#lerr').innerHTML = errBox(er.message); } };
    return;
  }
  const pl = S.me.player_id ? (await api('/api/players/' + S.me.player_id)).player : null;
  view(`<div class="stack">
    <section class="card hero" style="padding:22px 18px"><div class="row" style="gap:14px">${avatar(pl ? pl.gamer_tag : S.me.username, pl ? pl.avatar_hue : 265, false, 'lg')}<div class="grow"><div class="eyebrow">${esc({ admin: 'Admin', organizer: 'Organizer', player: 'Player' }[S.me.role])} account</div><h1 style="font-size:24px;margin:2px 0" class="ellipsis">${esc(pl ? pl.gamer_tag : S.me.username)}</h1><div class="small muted">@${esc(S.me.username)}</div></div></div>
      <div class="row wrap" style="margin-top:16px">${pl ? `<a class="btn sm" href="#/p/${pl.id}">${icon('user')}Public profile</a>` : ''}${isStaff() ? `<a class="btn sm" href="#/admin">${icon('shield')}Admin</a>` : ''}${S.me.role === 'admin' ? `<a class="btn sm" href="#/system">${icon('cpu')}System</a>` : ''}<button class="btn sm ghost" id="logout">Log out</button></div></section>
    ${settingsCard()}
    ${pl ? `<div class="card"><h3 style="font-size:15px;margin-bottom:12px">Edit profile</h3><form class="form" id="pf"><label class="field">Gamer tag<input class="input" name="gamer_tag" value="${esc(pl.gamer_tag)}" required></label><label class="field">Real name <span class="hint">(optional, public)</span><input class="input" name="real_name" value="${esc(pl.real_name || '')}"></label><label class="field">Bio<textarea class="input" name="bio" maxlength="280">${esc(pl.bio || '')}</textarea></label><div id="perr"></div><button class="btn primary">Save profile</button></form></div>` : ''}
    ${S.me.role !== 'admin' ? `<div class="card"><h3 style="font-size:15px;margin-bottom:12px">Change password</h3><form class="form" id="cpf"><label class="field">Current password<input class="input" type="password" name="current_password" autocomplete="current-password" required></label><label class="field">New password<input class="input" type="password" name="new_password" minlength="8" autocomplete="new-password" required></label><div id="cperr"></div><button class="btn">Update password</button></form></div>` : `<div class="notice">The admin password is set with the <b>&nbsp;ADMIN_PASSWORD&nbsp;</b> environment variable (Render → Environment).</div>`}
  </div>`);
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); await refreshMe(); toast('Logged out'); render(); };
  const pf = $('#pf'); if (pf) pf.onsubmit = async e => { e.preventDefault(); try { await api('/api/me', { method: 'PUT', body: Object.fromEntries(new FormData(pf)) }); toast('Profile saved'); } catch (er) { $('#perr').innerHTML = errBox(er.message); } };
  const cp = $('#cpf'); if (cp) cp.onsubmit = async e => { e.preventDefault(); try { await api('/api/me', { method: 'PUT', body: Object.fromEntries(new FormData(cp)) }); cp.reset(); toast('Password updated'); } catch (er) { $('#cperr').innerHTML = errBox(er.message); } };
}, 'me');
route(/^\/signup$/, async () => {
  await refreshMe();
  if (S.me) { location.hash = '#/me'; return; }
  view(`<div class="stack"><section class="card hero" style="padding:24px 18px"><div class="eyebrow">Join the community</div><h1 style="font-size:28px">Create your <span>gamz</span> profile</h1><p>Claim your gamer tag. If an organizer already added you to a tournament, use the exact same tag and your results link up.</p>
    ${S.signup ? `<form class="form" id="sf"><label class="field">Gamer tag<input class="input" name="gamer_tag" required maxlength="24" placeholder="e.g. KmerViper"></label><label class="field">Username <span class="hint">for logging in</span><input class="input" name="username" autocapitalize="none" autocomplete="username" required></label><label class="field">Password <span class="hint">at least 8 characters</span><input class="input" type="password" name="password" minlength="8" autocomplete="new-password" required></label><div id="serr"></div><button class="btn primary block">Create account</button></form>` : '<div class="notice">Sign-up is currently closed. Ask an organizer.</div>'}
    <p class="small" style="margin:14px 0 0;text-align:center">Already have an account? <a href="#/me" style="color:var(--purple);font-weight:600">Log in</a></p></section>${settingsCard()}</div>`);
  const f = $('#sf'); if (f) f.onsubmit = async e => { e.preventDefault(); try { const b = Object.fromEntries(new FormData(f)); await api('/api/signup', { method: 'POST', body: b }); await api('/api/me', { method: 'PUT', body: { theme: currentTheme() } }).catch(() => {}); await refreshMe(); toast('Welcome to gamz, ' + b.gamer_tag + '!'); location.hash = '#/me'; } catch (er) { $('#serr').innerHTML = errBox(er.message); } };
}, 'me');

/* ===================== ADMIN ===================== */
const needStaff = () => { if (!isStaff()) throw Object.assign(new Error('Organizers only'), { status: 401 }); };
function tournamentForm(t = {}) {
  const gid = t.game_id || S.games[0].id, locked = !!(t.id && t.matches_total);
  return `<form class="form" id="tf">
    <label class="field">Game<select class="input" name="game_id" ${locked ? 'disabled' : ''}>${S.games.map(g => `<option value="${g.id}" ${g.id === gid ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <label class="field">Name<input class="input" name="name" required value="${esc(t.name || '')}" placeholder="e.g. gamz Friday Cup"></label>
    <div class="two"><label class="field">Format<select class="input" name="format" ${locked ? 'disabled' : ''}></select></label><label class="field">Mode<select class="input" name="mode" ${locked ? 'disabled' : ''}></select></label></div>
    <div class="two" data-show="series"><label class="field">Best of<select class="input" name="best_of">${[1, 3, 5, 7].map(n => `<option ${n === (t.best_of > 1 ? t.best_of : 3) ? 'selected' : ''}>${n}</option>`).join('')}</select></label><span></span></div>
    <div class="two" data-show="league"><label class="field">Groups<input class="input" name="group_count" inputmode="numeric" value="${t.group_count || 1}" ${locked ? 'disabled' : ''}></label><label class="field" data-show="lko">Advance per group<input class="input" name="advance_per_group" inputmode="numeric" value="${t.advance_per_group || 2}"></label></div>
    <div data-show="br" class="form"><div class="two"><label class="field">Matches / maps<input class="input" name="br_match_count" inputmode="numeric" value="${t.br_match_count || 6}" ${locked ? 'disabled' : ''}></label><label class="field">Points per kill<input class="input" name="kill_points" inputmode="decimal" value="${t.kill_points ?? 1}"></label></div>
      <label class="field">Placement points <span class="hint">1st, 2nd, 3rd… (PMCO-style default)</span><input class="input" name="points_table" value="${esc(t.points_table ? JSON.parse(t.points_table).join(', ') : S.pointsTable.join(', '))}"></label></div>
    <div class="two"><label class="field">Starts<input class="input" type="datetime-local" name="starts_at" value="${esc(t.starts_at || '')}"></label><label class="field">Prize<input class="input" name="prize" value="${esc(t.prize || '')}" placeholder="optional"></label></div>
    <label class="field">Description<textarea class="input" name="description">${esc(t.description || '')}</textarea></label>
    ${!locked ? `<label class="field">Visibility<select class="input" name="status"><option value="registration" ${t.status !== 'draft' ? 'selected' : ''}>Public (registration open)</option><option value="draft" ${t.status === 'draft' ? 'selected' : ''}>Draft (hidden)</option></select></label>` : ''}
    <div id="tferr"></div><button class="btn primary block">${t.id ? 'Save changes' : 'Create tournament'}</button></form>`;
}
function wireTournamentForm(root, t, done) {
  const f = $('#tf', root);
  const sync = () => {
    const g = S.gameById[f.game_id.value], fm = f.format.value || t.format, md = f.mode.value || t.mode;
    f.format.innerHTML = g.formats.map(x => `<option value="${x}" ${x === fm ? 'selected' : ''}>${FORMAT[x]}</option>`).join('');
    let modes = g.modes; if (g.id === 'codm') modes = f.format.value === 'br_points' ? ['squad', 'duo', 'solo'] : ['5v5'];
    f.mode.innerHTML = modes.map(x => `<option value="${x}" ${x === md ? 'selected' : ''}>${MODE[x]}</option>`).join('');
    const F = f.format.value;
    $$('[data-show]', root).forEach(e => { const k = e.dataset.show; e.hidden = !(k === 'series' ? g.family === 'team_shooter' && F !== 'br_points' : k === 'league' ? F.startsWith('league') : k === 'lko' ? F === 'league_knockout' : k === 'br' ? F === 'br_points' : true); });
  };
  f.game_id.onchange = () => { f.format.value = ''; sync(); }; f.format.onchange = sync; sync();
  f.onsubmit = async e => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    $$('[data-show]', root).forEach(x => { if (x.hidden) $$('[name]', x).forEach(i => delete b[i.name]); });
    try { const r = await api(t.id ? '/api/tournaments/' + t.id : '/api/tournaments', { method: t.id ? 'PUT' : 'POST', body: b }); closeModal(); toast(t.id ? 'Saved' : 'Tournament created'); done(r); }
    catch (er) { $('#tferr', root).innerHTML = errBox(er.message); }
  };
}
route(/^\/admin$/, async (_, q) => {
  await refreshMe(); needStaff();
  let openNew = !!q.new;
  const draw = async () => {
    const [ts, players, teams, users] = await Promise.all([api('/api/tournaments'), api('/api/players'), api('/api/teams'), S.me.role === 'admin' ? api('/api/users') : Promise.resolve(null)]);
    const open = ts.filter(t => t.status !== 'completed'), done = ts.filter(t => t.status === 'completed');
    const toPlay = open.reduce((s, t) => s + (t.matches_total - t.matches_done), 0);
    view(`<div class="row" style="margin:4px 2px 14px"><div><div class="eyebrow">${esc(S.me.role)} · @${esc(S.me.username)}</div><h1 style="font-size:26px">Organizer desk</h1></div><button class="btn sm primary right" id="newT">${icon('plus')}New</button></div>
      <div class="kpis"><div class="kpi"><span>Active events</span><b>${open.length}</b></div><div class="kpi"><span>Matches left</span><b>${toPlay}</b></div><div class="kpi"><span>Players</span><b>${players.length}</b></div><div class="kpi"><span>Teams</span><b>${teams.length}</b></div></div>
      <div class="section-title"><h2>Active tournaments</h2></div>
      <div class="card pad-0 list">${open.length ? open.map(t => `<a class="list-row g-${t.game_id}" href="#/admin/t/${t.id}"><div class="grow"><div class="ellipsis" style="font-weight:600">${esc(t.name)}</div><div class="tiny">${gameTag(t.game_id)} <span class="dim">· ${t.participant_count} entrants · ${t.matches_done}/${t.matches_total} done</span></div></div>${badge(t.status)}</a>`).join('') : empty('No active tournaments.')}</div>
      ${done.length ? `<div class="section-title"><h2>Completed</h2></div><div class="card pad-0 list">${done.map(t => `<a class="list-row" href="#/admin/t/${t.id}"><div class="grow"><div class="ellipsis" style="font-weight:600">${esc(t.name)}</div><div class="tiny">${gameTag(t.game_id)} <span class="dim">· 🏆 ${esc(t.champion || '')}</span></div></div>${badge(t.status)}</a>`).join('')}</div>` : ''}
      <div class="cols">
        <div><div class="section-title"><h2>Players</h2><span class="tiny dim">${players.length}</span></div>
          <div class="card"><form class="row" id="apf"><input class="input grow" name="gamer_tag" placeholder="New player gamer tag" required><button class="btn">${icon('plus')}Add</button></form></div></div>
        <div><div class="section-title"><h2>Teams</h2><span class="tiny dim">${teams.length}</span></div>
          <div class="card"><button class="btn block" id="newTeam">${icon('plus')}New team with roster</button></div></div>
      </div>
      ${users ? `<div class="section-title"><h2>Organizer accounts</h2><span class="tiny dim">admin only</span></div>
        <div class="card pad-0 list">${users.filter(u => u.role !== 'player').map(u => `<div class="list-row">${avatar(u.username, 270)}<div class="grow"><div style="font-weight:600">${esc(u.username)}</div><div class="tiny dim">${esc(u.role)}</div></div>${u.role === 'organizer' ? `<button class="btn sm ghost" data-deluser="${u.id}">Remove</button>` : ''}</div>`).join('')}</div>
        <div class="card" style="margin-top:10px"><form class="form" id="auf"><div class="two"><input class="input" name="username" placeholder="username" autocapitalize="none" required><input class="input" name="password" type="password" placeholder="password (8+)" minlength="8" required autocomplete="new-password"></div><button class="btn">${icon('plus')}Add organizer</button></form></div>
        <p class="tiny dim" style="margin:8px 4px">${plural(users.filter(u => u.role === 'player').length, 'player account')} signed up.</p>` : ''}`);
    $('#newT').onclick = () => openModal(`<h2>New tournament</h2>${tournamentForm()}`, r => wireTournamentForm(r, {}, t => { location.hash = '#/admin/t/' + t.id; }));
    $('#apf').onsubmit = async e => { e.preventDefault(); try { await api('/api/players', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Player added'); draw(); } catch (er) { toast(er.message, true); } };
    $('#newTeam').onclick = () => openModal(`<h2>New team</h2><form class="form" id="ntf"><label class="field">Team name<input class="input" name="name" required></label><div class="two"><label class="field">Tag<input class="input" name="tag" maxlength="6" placeholder="e.g. MBV"></label><label class="field">Game<select class="input" name="game_id">${S.games.filter(g => g.family !== 'football').map(g => `<option value="${g.id}">${esc(g.short_name)}</option>`).join('')}</select></label></div>
      <div class="field">Roster <span class="hint">first selected = captain</span><input class="input" id="flt" placeholder="Filter players…" style="margin:4px 0"><div class="member-picks">${players.map(p => `<label><input type="checkbox" value="${p.id}"><span>${esc(p.gamer_tag)}</span></label>`).join('')}</div></div><div id="nterr"></div><button class="btn primary block">Create team</button></form>`, r => {
      const picked = []; $$('.member-picks input', r).forEach(i => i.onchange = () => { if (i.checked) picked.push(+i.value); else picked.splice(picked.indexOf(+i.value), 1); });
      $('#flt', r).oninput = e => $$('.member-picks label', r).forEach(l => { l.hidden = !l.textContent.toLowerCase().includes(e.target.value.toLowerCase()); });
      $('#ntf', r).onsubmit = async e => { e.preventDefault(); try { await api('/api/teams', { method: 'POST', body: { ...Object.fromEntries(new FormData(e.target)), members: picked } }); closeModal(); toast('Team created'); draw(); } catch (er) { $('#nterr', r).innerHTML = errBox(er.message); } };
    });
    const auf = $('#auf'); if (auf) auf.onsubmit = async e => { e.preventDefault(); try { await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(auf)) }); toast('Organizer added'); draw(); } catch (er) { toast(er.message, true); } };
    $$('[data-deluser]').forEach(b => b.onclick = async () => { if (!confirm('Remove this organizer account?')) return; await api('/api/users/' + b.dataset.deluser, { method: 'DELETE' }); draw(); });
    if (openNew) { openNew = false; $('#newT').click(); }
  };
  await draw();
  return { onUpdate: () => { if ($('#modal').hidden) draw(); } };
}, 'admin');

route(/^\/admin\/t\/(\d+)$/, async ([id]) => {
  await refreshMe(); needStaff();
  let d, pool = [];
  const load = async () => { d = await api('/api/tournaments/' + id); pool = isTeamMode(d.tournament) ? await api('/api/teams') : await api('/api/players'); };
  const draw = () => {
    const t = d.tournament, P = nameMap(d), generated = d.matches.length > 0, inIds = new Set(d.participants.map(p => isTeamMode(t) ? p.team_id : p.player_id));
    const ready = d.matches.filter(m => m.status === 'ready' && m.stage !== 'br'), brm = d.matches.filter(m => m.stage === 'br');
    const leagueDone = t.format === 'league_knockout' && d.matches.length && d.matches.filter(m => m.stage === 'league').every(m => m.status === 'completed') && !d.matches.some(m => m.stage === 'winners');
    const y = scrollY;
    view(`<div class="row" style="margin:0 2px 12px"><a class="btn sm ghost" href="#/admin">← Desk</a><a class="btn sm right" href="#/t/${t.id}">Public page <span style="width:16px">${icon('arrow')}</span></a></div>
      <section class="card t-head g-${esc(t.game_id)}"><div class="row">${gameTag(t.game_id)}<span class="right">${badge(t.status)}</span></div><h1>${esc(t.name)}</h1><div class="kv"><span>${FORMAT[t.format]}</span><span>${MODE[t.mode]}</span>${t.family === 'team_shooter' && t.format !== 'br_points' ? `<span>Bo${t.best_of}</span>` : ''}<span>${d.participants.length} entrants</span></div>
        <div class="row wrap" style="margin-top:14px"><button class="btn sm" id="editT">${icon('edit')}Edit details</button>${generated ? '<button class="btn sm ghost" id="resetB">Reset bracket</button>' : '<button class="btn sm ghost" id="delT">Delete</button>'}</div></section>
      ${!generated ? `
        <div class="section-title"><h2>Registration</h2><span class="tiny dim">${plural(d.participants.length, isTeamMode(t) ? 'team' : 'player')}</span></div>
        <div class="card"><form class="form" id="regf"><label class="field">Add existing ${isTeamMode(t) ? 'team' : 'player'}<select class="input" name="pick"><option value="">Choose…</option>${pool.filter(x => !inIds.has(x.id)).map(x => `<option value="${x.id}">${esc(x.gamer_tag || x.name)}</option>`).join('')}</select></label><label class="field">…or quick-add a new one<input class="input" name="new_name" placeholder="${isTeamMode(t) ? 'Team name' : 'Gamer tag'}"></label><button class="btn">${icon('plus')}Register</button></form></div>
        <div class="card pad-0" style="margin-top:10px">${d.participants.length ? d.participants.map((p, i) => `<div class="seed-row"><span class="s">${i + 1}</span>${avatar(p.name, p.avatar_hue, !!p.team_id)}<span class="grow ellipsis" style="font-weight:600">${esc(p.name)}</span><button class="mini-btn" data-mv="${i}" data-d="-1" aria-label="Move up">${icon('up')}</button><button class="mini-btn" data-mv="${i}" data-d="1" aria-label="Move down">${icon('down')}</button><button class="mini-btn" data-rm="${p.id}" aria-label="Remove">${icon('x')}</button></div>`).join('') : empty('Nobody registered yet.')}</div>
        <p class="tiny dim" style="margin:8px 4px">Order = seeding (1 is strongest). When the count isn't a power of 2, top seeds get byes.</p>
        <div class="row wrap"><button class="btn primary grow" id="gen">${icon('trophy')}${t.format === 'br_points' ? 'Create match schedule' : t.format.startsWith('league') ? 'Generate fixtures' : 'Generate seeded bracket'}</button>${t.format !== 'br_points' ? `<button class="btn grow" id="genR">${icon('shuffle')}Random draw</button>` : ''}</div>` : `
        ${leagueDone ? `<div class="card" style="margin-top:14px"><div class="row"><div class="grow"><b>Group stage complete</b><div class="tiny dim">Top ${t.advance_per_group} per group go through.</div></div><button class="btn primary" id="ko">Draw knockout</button></div></div>` : ''}
        ${brm.length ? `<div class="section-title"><h2>Matches</h2><span class="tiny dim">tap to enter placements & kills</span></div><div class="card pad-0 list">${brm.map(m => `<div class="list-row" data-mid="${m.id}" style="cursor:pointer"><div class="grow"><div style="font-weight:600">${esc(m.label)} · ${esc(m.map_name || '')}</div><div class="tiny dim">${m.status === 'completed' ? (m.br || []).length + ' results entered' : 'No results yet'}</div></div><span class="btn sm ${m.status === 'completed' ? '' : 'primary'}">${m.status === 'completed' ? 'Edit' : 'Enter results'}</span></div>`).join('')}</div>`
          : `<div class="section-title"><h2>Up next</h2><span class="tiny dim">${plural(ready.length, 'match')} ready</span></div>
            <div class="card pad-0 list">${ready.length ? ready.map(m => `<div class="list-row" data-mid="${m.id}" style="cursor:pointer"><div class="grow" style="min-width:0"><div class="tiny dim">${esc(m.group_label ? m.group_label + ' · ' : '')}${esc(m.label)}</div><div class="ellipsis" style="font-weight:600">${esc(P.get(m.home_id)?.name)} <span class="dim">vs</span> ${esc(P.get(m.away_id)?.name)}</div></div><span class="btn sm primary">Enter result</span></div>`).join('') : empty(t.status === 'completed' ? 'All done — tournament completed 🏆' : 'Waiting for earlier results.')}</div>
            ${d.matches.some(m => m.stage === 'winners') ? `<div class="section-title"><h2>Bracket</h2><span class="tiny dim">tap a match to edit</span></div><div class="card" style="padding:12px 12px 6px">${bracketHTML(d, bracketStages(t))}</div>` : ''}
            ${t.format.startsWith('league') ? `<div class="section-title"><h2>All fixtures</h2></div>${matchesList(d)}` : ''}`}`}`);
    scrollTo(0, y);
    const on = (s, fn) => { const e = $(s); if (e) e.onclick = fn; };
    on('#editT', () => openModal(`<h2>Edit tournament</h2>${tournamentForm({ ...t, matches_total: d.matches.length })}`, r => wireTournamentForm(r, { ...t }, async () => { await load(); draw(); })));
    on('#resetB', async () => { if (!confirm('Reset the bracket? ALL results in this tournament will be deleted.')) return; await api(`/api/tournaments/${id}/reset`, { method: 'POST' }); toast('Bracket reset'); await load(); draw(); });
    on('#delT', async () => { if (!confirm('Delete this tournament?')) return; await api('/api/tournaments/' + id, { method: 'DELETE' }); location.hash = '#/admin'; });
    on('#ko', async () => { try { await api(`/api/tournaments/${id}/knockout`, { method: 'POST' }); toast('Knockout drawn'); await load(); draw(); } catch (e) { toast(e.message, true); } });
    const gen = async pairing => { try { await api(`/api/tournaments/${id}/generate`, { method: 'POST', body: { pairing } }); toast('Generated — it is live!'); await load(); draw(); } catch (e) { toast(e.message, true); } };
    on('#gen', () => gen('seeded')); on('#genR', () => gen('random'));
    const rf = $('#regf'); if (rf) rf.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(rf)); const body = b.new_name ? { new_name: b.new_name } : isTeamMode(t) ? { team_id: b.pick } : { player_id: b.pick }; try { await api(`/api/tournaments/${id}/participants`, { method: 'POST', body }); await load(); draw(); } catch (er) { toast(er.message, true); } };
    $$('[data-rm]').forEach(b => b.onclick = async () => { await api(`/api/tournaments/${id}/participants/${b.dataset.rm}`, { method: 'DELETE' }); await load(); draw(); });
    $$('[data-mv]').forEach(b => b.onclick = async () => { const ids = d.participants.map(p => p.id), i = +b.dataset.mv, j = i + +b.dataset.d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await api(`/api/tournaments/${id}/seeds`, { method: 'PUT', body: { order: ids } }); await load(); draw(); });
  };
  const onClick = e => { const el = e.target.closest('[data-mid]'); if (!el || !d) return; const m = d.matches.find(x => x.id === +el.dataset.mid); if (m && canEdit(m)) openResultForm(d, m); };
  app.addEventListener('click', onClick);
  await load(); draw();
  return { destroy: () => app.removeEventListener('click', onClick), reload: async () => { await load(); draw(); }, onUpdate: async ev => { if ((!ev.tournament_id || ev.tournament_id === +id) && $('#modal').hidden) { await load(); draw(); } } };
}, 'admin');

/* ===================== SYSTEM ===================== */
route(/^\/system$/, async () => {
  await refreshMe(); if (!S.me || S.me.role !== 'admin') throw Object.assign(new Error('Admin only'), { status: 403 });
  const draw = async () => {
    const s = await api('/api/system'), up = s.uptime_s, upT = up >= 3600 ? Math.floor(up / 3600) + ' h ' + Math.floor(up % 3600 / 60) + ' m' : Math.floor(up / 60) + ' m ' + up % 60 + ' s';
    view(`<div class="row" style="margin:4px 2px 14px"><div><div class="eyebrow">Admin</div><h1 style="font-size:26px">System</h1></div><span class="badge live right">Healthy</span></div>
      <div class="kpis"><div class="kpi"><span>Database</span><b>${s.db_mode === 'turso' ? 'Turso (cloud)' : 'Local file'}</b></div><div class="kpi"><span>Uptime</span><b>${upT}</b></div><div class="kpi"><span>Live viewers</span><b>${s.live_viewers}</b></div><div class="kpi"><span>Memory</span><b>${s.memory_mb} MB</b></div></div>
      ${s.db_mode !== 'turso' && s.production ? `<div class="err-box" style="margin-top:12px">⚠️ Running in production without GAMZ_DATABASE_URL — data will be lost when Render restarts.</div>` : ''}
      <div class="section-title"><h2>Environment</h2></div>
      <div class="card pad-0 list">
        ${[['Database', s.db], ['Mode', s.production ? 'production' : 'development (local)'], ['Node.js', s.node], ['Admin username', s.admin_user], ['Player sign-up', s.signup_open ? 'open' : 'closed (ALLOW_SIGNUP=false)'], ['Leaderboard', `v${s.leaderboard_version} · computed ${ago(s.leaderboard_computed_at)}`]].map(([k, v]) => `<div class="list-row"><span class="grow muted small">${k}</span><span class="small" style="font-weight:600;text-align:right;word-break:break-all">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="section-title"><h2>Tables</h2><span class="tiny dim">row counts</span></div>
      <div class="card pad-0"><div class="table-wrap"><table class="tbl"><tbody>${Object.entries(s.counts).map(([k, v]) => `<tr><td class="l" style="text-align:left;width:auto;padding-left:16px">${k}</td><td class="total">${v}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="section-title"><h2>Migrations</h2></div>
      <div class="card pad-0 list">${s.migrations.map(m => `<div class="list-row"><span class="ok-dot"></span><span class="grow small" style="font-weight:600">${esc(m.name)}</span><span class="tiny dim">applied ${esc(ago(m.applied_at))}</span></div>`).join('')}</div>
      <div class="section-title"><h2>Example data</h2></div>
      <div class="card">${s.example_rows ? `<p class="small muted" style="margin-top:0">The database contains example players, teams and tournaments (marked “Example”). Remove them before your first real event.</p><button class="btn block" id="clearEx">Remove example data</button>` : '<p class="small muted" style="margin:0">No example data — real data only.</p>'}</div>
      <div class="section-title"><h2>Appearance</h2></div>${settingsCard()}`);
    const c = $('#clearEx'); if (c) c.onclick = async () => { if (!confirm('Delete ALL example players, teams and tournaments? Real data is kept.')) return; await api('/api/system/clear-example-data', { method: 'POST' }); toast('Example data removed'); draw(); };
  };
  await draw(); return { onUpdate: draw };
}, 'system');

/* ---------- boot ---------- */
(async () => {
  try { const g = await api('/api/games'); S.games = g.games; S.pointsTable = g.default_points_table; S.games.forEach(x => { S.gameById[x.id] = x; }); } catch (e) { toast('Could not reach the server', true); }
  await refreshMe().catch(() => {});
  connectLive();
  render();
})();
