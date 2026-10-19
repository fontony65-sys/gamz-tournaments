// gamz tournaments — Express server.
// Load .env for local use if present (Node >= 20.12). Real env vars (e.g. on Render) take precedence.
try { if (require('fs').existsSync(__dirname + '/.env')) process.loadEnvFile(__dirname + '/.env'); } catch (e) { console.warn('Could not load .env:', e.message); }
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { open, migrate, IS_REMOTE, describe } = require('./db');
const E = require('./lib/engine');
const LB = require('./lib/leaderboard');
const { DEFAULT_POINTS_TABLE } = require('./lib/scoring');
const IDS = require('./lib/ids');

const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';
if (PROD && !process.env.ADMIN_PASSWORD) { console.error('FATAL: ADMIN_PASSWORD must be set when NODE_ENV=production. Refusing to start.'); process.exit(1); }
if (PROD && process.env.ADMIN_PASSWORD.length < 8) { console.error('FATAL: ADMIN_PASSWORD must be at least 8 characters.'); process.exit(1); }
if (PROD && !IS_REMOTE) console.warn('WARNING: GAMZ_DATABASE_URL is not set — using a local file. On Render free this is wiped on every restart/deploy!');

// Local development: if no ADMIN_PASSWORD is given, generate one and keep it in .admin-password.local (git-ignored).
function localAdminPassword() {
  const f = path.join(__dirname, '.admin-password.local');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const p = 'gamz-' + crypto.randomBytes(6).toString('base64url');
  fs.writeFileSync(f, p + '\n', { mode: 0o600 });
  return p;
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || localAdminPassword();

const db = open();
const app = express();
app.set('trust proxy', 1);   // Render sits behind a proxy: req.ip = real client IP, secure cookies work
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

// ---------- passwords & sessions ----------
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`; };
const checkPw = (pw, stored) => { const [, salt, h] = String(stored).split('$'); if (!salt || !h) return false; const a = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(h, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const hashTok = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const TTL = 7 * 24 * 3600 * 1000;
const COOKIE = 'gamz_session';
const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${PROD ? '; Secure' : ''}`;
function tokenFrom(req) {
  const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) return h.slice(7);
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`)); return m && m[1];
}
async function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hashTok(token), user.id, now + TTL);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags}; Max-Age=${TTL / 1000}`);
  return token;
}
const publicUser = u => !u ? null : ({ id: u.id, username: u.username, role: u.role, player_id: u.player_id, theme: u.theme || null });

// Rate limit: 10 failed logins (or 5 sign-ups) per IP per 15 minutes.
const LIMIT = +process.env.LOGIN_MAX_ATTEMPTS || 10, WINDOW = 15 * 60 * 1000, attempts = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k); }, 60000).unref();
function limited(key, max, res) {
  const now = Date.now(); let a = attempts.get(key); if (!a || a.reset < now) { a = { n: 0, reset: now + WINDOW }; attempts.set(key, a); }
  if (a.n >= max) { res.setHeader('Retry-After', Math.ceil((a.reset - now) / 1000)); res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' }); return null; }
  return a;
}

const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { const st = e.status || (/constraint|CHECK|UNIQUE|FOREIGN/i.test(e.message) ? 400 : 500); if (st === 500) console.error(e);
    const msg = /UNIQUE/i.test(e.message)
      ? (/users\.username|username/i.test(e.message) ? 'That username is taken' : 'That name is already taken')
      : e.message;
    res.status(st).json({ error: msg }); }
};

// Username uniqueness: reserved admin name + taken check (UNIQUE COLLATE NOCASE is the final DB guard).
async function assertUsernameAvailable(username) {
  const wanted = String(username).trim();
  if (wanted.toLowerCase() === ADMIN_USER.toLowerCase()) {
    const e = Object.assign(new Error('That username is reserved'), { status: 400 }); throw e;
  }
  const adminRow = await db.get("SELECT username FROM users WHERE role='admin' LIMIT 1");
  if (adminRow && String(adminRow.username).toLowerCase() === wanted.toLowerCase()) {
    const e = Object.assign(new Error('That username is reserved'), { status: 400 }); throw e;
  }
  if (await db.get('SELECT 1 FROM users WHERE username=?', wanted)) {
    const e = Object.assign(new Error('That username is taken'), { status: 400 }); throw e;
  }
}
const need = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this' });
  next();
};
const STAFF = need('admin', 'organizer');

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(data) {
  const msg = `event: update\ndata: ${JSON.stringify({ ...data, at: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();
function changed(info = {}) { LB.invalidate(); broadcast(info); }

// ---------- static ----------
const PUB = path.join(__dirname, 'public');
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(PUB, 'manifest.webmanifest')));
app.use(express.static(PUB, { index: false, maxAge: PROD ? '1h' : 0 }));
app.get('/', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

// ---------- public API ----------
app.get('/api/health', (req, res) => res.json({ ok: true, db: IS_REMOTE ? 'turso' : 'local-file' }));
app.use('/api', async (req, res, next) => {
  try {
    const t = tokenFrom(req);
    if (t) {
      const u = await db.get('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', hashTok(t));
      if (u && u.expires_at > Date.now()) req.user = u;
    }
    next();
  } catch (e) { next(e); }
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ clients: clients.size + 1 })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user), signup: ALLOW_SIGNUP }));

app.post('/api/login', wrap(async (req, res) => {
  const a = limited('login:' + req.ip, LIMIT, res); if (!a) return;
  const { username, password } = req.body || {};
  const u = username && await db.get('SELECT * FROM users WHERE username=?', String(username).trim());
  if (!u || !checkPw(password || '', u.password_hash)) { a.n++; return res.status(401).json({ error: 'Wrong username or password' }); }
  attempts.delete('login:' + req.ip);
  const token = await startSession(res, u);
  res.json({ token, user: publicUser(u) });
}));
app.post('/api/logout', wrap(async (req, res) => {
  const t = tokenFrom(req); if (t) await db.run('DELETE FROM sessions WHERE token_hash=?', hashTok(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags}; Max-Age=0`); res.json({ ok: true });
}));
const TAG_RE = /^[\p{L}\p{N}_. \-]{2,24}$/u;
app.post('/api/signup', wrap(async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'Sign-up is closed. Ask an organizer.' });
  const a = limited('signup:' + req.ip, 5, res); if (!a) return;
  const username = String(req.body?.username || '').trim(), password = String(req.body?.password || ''), tag = String(req.body?.gamer_tag || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username: 3–24 letters, numbers, _ . -' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!TAG_RE.test(tag)) return res.status(400).json({ error: 'Gamer tag: 2–24 characters' });
  await assertUsernameAvailable(username);
  let p = await db.get('SELECT p.* FROM players p WHERE p.gamer_tag=?', tag);
  if (p && await db.get('SELECT 1 FROM users WHERE player_id=?', p.id)) return res.status(400).json({ error: 'That gamer tag already belongs to an account' });
  if (req.body?.game_id && req.body?.in_game_id) { // optional: link a first in-game ID right away (validated before creating anything)
    const g = await db.get('SELECT * FROM games WHERE id=?', req.body.game_id); if (!g) return res.status(400).json({ error: 'Unknown game' });
    const clash = await db.get('SELECT player_id FROM player_game_ids WHERE game_id=? AND in_game_id=?', g.id, String(req.body.in_game_id).trim());
    if (clash && (!p || clash.player_id !== p.id)) return res.status(400).json({ error: `That ${g.id_label} is already linked to another gamz player` });
  }
  a.n++;
  if (!p) p = await IDS.createPlayer(db, { gamer_tag: tag });
  if (req.body?.game_id && req.body?.in_game_id) await IDS.setGameId(db, p.id, req.body.game_id, req.body);
  const r = await db.run(`INSERT INTO users (username,password_hash,role,player_id) VALUES (?,?,'player',?)`, username, hashPw(password), p.id);
  const u = await db.get('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
  await startSession(res, u); changed({ kind: 'players' });
  res.status(201).json({ user: publicUser(u) });
}));
app.put('/api/me', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  const b = req.body || {};
  if (b.theme !== undefined) { if (!['dark', 'light', null].includes(b.theme)) return res.status(400).json({ error: 'theme must be dark or light' }); await db.run('UPDATE users SET theme=? WHERE id=?', b.theme, req.user.id); }
  if (b.new_password !== undefined) {
    if (!checkPw(b.current_password || '', req.user.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
    if (String(b.new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (req.user.role === 'admin') return res.status(400).json({ error: 'The admin password comes from ADMIN_PASSWORD — change it there' });
    await db.run('UPDATE users SET password_hash=? WHERE id=?', hashPw(b.new_password), req.user.id);
  }
  if (req.user.player_id && (b.gamer_tag !== undefined || b.bio !== undefined || b.real_name !== undefined)) {
    if (b.gamer_tag !== undefined && !TAG_RE.test(String(b.gamer_tag).trim())) return res.status(400).json({ error: 'Gamer tag: 2–24 characters' });
    const f = {}; for (const k of ['gamer_tag', 'bio', 'real_name']) if (b[k] !== undefined) f[k] = String(b[k]).trim().slice(0, k === 'bio' ? 280 : 60) || null;
    const k = Object.keys(f); await db.run(`UPDATE players SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => f[x]), req.user.player_id);
    changed({ kind: 'players', player_id: req.user.player_id });
  }
  res.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id=?', req.user.id)) });
}));

// In-game IDs: players manage their own; organizers can manage anyone's.
async function putGameId(req, res, playerId) {
  if (!(await db.get('SELECT 1 FROM players WHERE id=?', playerId))) return res.status(404).json({ error: 'Player not found' });
  const row = await IDS.setGameId(db, playerId, req.params.game, req.body || {});
  changed({ kind: 'players', player_id: +playerId }); res.json({ game_id: row.game_id, in_game_id: row.in_game_id, in_game_name: row.in_game_name, game_ids: await IDS.gameIdsOf(db, playerId) });
}
async function delGameId(req, res, playerId) {
  await IDS.removeGameId(db, playerId, req.params.game); changed({ kind: 'players', player_id: +playerId }); res.json({ game_ids: await IDS.gameIdsOf(db, playerId) });
}
const mustPlayer = (req, res, next) => (!req.user ? res.status(401).json({ error: 'Please log in' }) : !req.user.player_id ? res.status(400).json({ error: 'This account has no player profile' }) : next());
app.put('/api/me/game-ids/:game', mustPlayer, wrap((req, res) => putGameId(req, res, req.user.player_id)));
app.delete('/api/me/game-ids/:game', mustPlayer, wrap((req, res) => delGameId(req, res, req.user.player_id)));

// Search players / teams by gamer tag, gamz ID (any spelling: gmz7k3q9p, 7K3Q9P…), in-game ID or in-game name.
app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60); if (q.length < 2) return res.json({ players: [], teams: [] });
  const like = `%${q}%`, gz = IDS.normalizeGamzId(q);
  const players = await db.all(`SELECT DISTINCT p.id, p.gamer_tag, p.gamz_id, p.avatar_hue, p.is_example,
      CASE WHEN p.gamz_id=? THEN 'gamz ID' WHEN p.gamer_tag LIKE ? THEN 'gamer tag' ELSE 'in-game ID' END AS matched
    FROM players p LEFT JOIN player_game_ids x ON x.player_id=p.id
    WHERE p.gamz_id=? OR p.gamz_id LIKE ? OR p.gamer_tag LIKE ? OR x.in_game_id LIKE ? OR x.in_game_name LIKE ?
    ORDER BY CASE WHEN p.gamz_id=? THEN 0 WHEN x.in_game_id=? THEN 1 ELSE 2 END, p.gamer_tag COLLATE NOCASE LIMIT 20`,
    gz, like, gz, like.toUpperCase(), like, like, like, gz, q);
  const all = players.length ? await db.all(`SELECT x.player_id, x.game_id, x.in_game_id, x.in_game_name, g.short_name AS game_short, g.id_label FROM player_game_ids x JOIN games g ON g.id=x.game_id WHERE x.player_id IN (${players.map(() => '?').join(',')}) ORDER BY g.sort_order`, ...players.map(p => p.id)) : [];
  const ql = q.toLowerCase();
  for (const p of players) {
    p.game_ids = all.filter(x => x.player_id === p.id).map(({ player_id, ...x }) => x);
    const hit = p.game_ids.find(x => x.in_game_id.toLowerCase().includes(ql) || (x.in_game_name || '').toLowerCase().includes(ql));
    if (p.matched === 'in-game ID') p.matched = hit ? (hit.in_game_id.toLowerCase().includes(ql) ? hit.id_label : hit.game_short + ' in-game name') : 'gamz ID';
  }
  const teams = await db.all(`SELECT t.id, t.name, t.tag, t.game_id FROM teams t WHERE t.name LIKE ? OR t.tag LIKE ? ORDER BY t.name LIMIT 10`, like, like);
  res.json({ players, teams });
}));

app.get('/api/games', wrap(async (req, res) => {
  const g = await db.all(`SELECT g.*, (SELECT COUNT(*) FROM tournaments t WHERE t.game_id=g.id) AS tournament_count,
    (SELECT COUNT(*) FROM tournaments t WHERE t.game_id=g.id AND t.status='live') AS live_count FROM games g ORDER BY sort_order`);
  g.forEach(x => { x.formats = JSON.parse(x.formats); x.modes = JSON.parse(x.modes); });
  res.json({ games: g, default_points_table: DEFAULT_POINTS_TABLE });
}));

const T_LIST = `SELECT t.*, g.name AS game_name, g.short_name AS game_short, g.family, g.accent,
  (SELECT COUNT(*) FROM participants p WHERE p.tournament_id=t.id) AS participant_count,
  (SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id AND m.status IN ('completed','bye','void')) AS matches_done,
  (SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id) AS matches_total
  FROM tournaments t JOIN games g ON g.id=t.game_id`;
async function withChampions(list) {
  for (const t of list) if (t.status === 'completed') { const d = await E.loadTournament(db, t.id); const c = d.participants.find(p => p.rank === 1); t.champion = c ? c.name : null; }
  return list;
}
app.get('/api/tournaments', wrap(async (req, res) => {
  const w = [], a = [];
  if (req.query.game) { w.push('t.game_id=?'); a.push(req.query.game); }
  if (req.query.status) { w.push('t.status=?'); a.push(req.query.status); }
  if (!req.user || req.user.role === 'player') w.push(`t.status<>'draft'`);
  const list = await db.all(T_LIST + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ` ORDER BY CASE t.status WHEN 'live' THEN 0 WHEN 'registration' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, COALESCE(t.starts_at, t.created_at) DESC`, ...a);
  res.json(await withChampions(list));
}));
app.get('/api/tournaments/:id', wrap(async (req, res) => {
  const d = await E.loadTournament(db, req.params.id);
  if (d.tournament.status === 'draft' && !(req.user && req.user.role !== 'player')) return res.status(404).json({ error: 'Tournament not found' });
  res.json(d);
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  const lb = await LB.get(db);
  if (req.query.game && req.query.game !== 'overall') { if (!lb.games[req.query.game]) return res.status(404).json({ error: 'Unknown game' }); return res.json({ version: lb.version, computed_at: lb.computed_at, game: req.query.game, rows: lb.games[req.query.game] }); }
  res.json({ version: lb.version, computed_at: lb.computed_at, game: 'overall', rows: lb.overall });
}));

async function recentFor(pids) {
  if (!pids.length) return [];
  const q = pids.map(() => '?').join(',');
  const ms = await db.all(`SELECT m.*, t.name AS tournament_name, t.game_id, r.home_score, r.away_score, r.home_pens, r.away_pens,
      COALESCE(hp.gamer_tag, ht.name) AS home_name, COALESCE(ap.gamer_tag, at.name) AS away_name
    FROM matches m JOIN tournaments t ON t.id=m.tournament_id JOIN match_results r ON r.match_id=m.id
    LEFT JOIN participants h ON h.id=m.home_id LEFT JOIN players hp ON hp.id=h.player_id LEFT JOIN teams ht ON ht.id=h.team_id
    LEFT JOIN participants a ON a.id=m.away_id LEFT JOIN players ap ON ap.id=a.player_id LEFT JOIN teams at ON at.id=a.team_id
    WHERE m.status='completed' AND (m.home_id IN (${q}) OR m.away_id IN (${q})) ORDER BY m.completed_at DESC, m.id DESC LIMIT 12`, ...pids, ...pids);
  const br = await db.all(`SELECT b.*, m.label, m.map_name, m.completed_at, t.name AS tournament_name, t.game_id, m.tournament_id FROM br_match_results b JOIN matches m ON m.id=b.match_id JOIN tournaments t ON t.id=m.tournament_id
    WHERE b.participant_id IN (${q}) ORDER BY m.completed_at DESC, m.id DESC LIMIT 12`, ...pids);
  return { matches: ms.map(m => ({ ...m, mine: pids.includes(m.home_id) ? 'home' : 'away' })), br };
}
async function historyFor(where, args) {
  const parts = await db.all(`SELECT pa.id, pa.tournament_id, t.name, t.game_id, t.status, t.format, t.mode, g.short_name AS game_short FROM participants pa JOIN tournaments t ON t.id=pa.tournament_id JOIN games g ON g.id=t.game_id WHERE ${where} AND t.status<>'draft' ORDER BY t.id DESC`, ...args);
  for (const p of parts) { const d = await E.loadTournament(db, p.tournament_id); p.rank = (d.participants.find(x => x.id === p.id) || {}).rank || null; }
  return parts;
}
app.get('/api/players', wrap(async (req, res) => res.json(await db.all(`SELECT p.*, (SELECT COUNT(*) FROM participants pa WHERE pa.player_id=p.id) AS solo_entries, (SELECT group_concat(x.game_id) FROM player_game_ids x WHERE x.player_id=p.id) AS linked_games FROM players p ORDER BY p.gamer_tag COLLATE NOCASE`))));
app.get('/api/players/:id', wrap(async (req, res) => {
  const p = await db.get('SELECT p.*, (SELECT username FROM users u WHERE u.player_id=p.id) AS account FROM players p WHERE id=?', req.params.id); if (!p) return res.status(404).json({ error: 'Player not found' });
  const teams = await db.all('SELECT t.*, tm.role, g.short_name AS game_short FROM team_members tm JOIN teams t ON t.id=tm.team_id LEFT JOIN games g ON g.id=t.game_id WHERE tm.player_id=?', p.id);
  const history = await historyFor('(pa.player_id=? OR pa.team_id IN (SELECT team_id FROM team_members WHERE player_id=?))', [p.id, p.id]);
  const lb = await LB.get(db), overall = lb.overall.find(r => r.id === p.id) || null;
  const per_game = Object.entries(lb.games).flatMap(([g, rows]) => rows.filter(r => (r.type === 'player' && r.id === p.id) || (r.type === 'team' && teams.some(t => t.id === r.id))).map(r => ({ game_id: g, ...r })));
  res.json({ player: { ...p, account: !!p.account }, game_ids: await IDS.gameIdsOf(db, p.id), teams, history, overall, per_game, recent: await recentFor(history.map(h => h.id)) });
}));
app.get('/api/teams', wrap(async (req, res) => res.json(await db.all(`SELECT t.*, g.short_name AS game_short, (SELECT COUNT(*) FROM team_members m WHERE m.team_id=t.id) AS member_count, (SELECT group_concat(DISTINCT x.game_id) FROM player_game_ids x WHERE x.player_id IN (SELECT player_id FROM team_members m WHERE m.team_id=t.id)) AS any_linked_games, (SELECT COUNT(*) FROM team_members m WHERE m.team_id=t.id AND NOT EXISTS (SELECT 1 FROM player_game_ids x WHERE x.player_id=m.player_id AND x.game_id=t.game_id)) AS members_missing_id FROM teams t LEFT JOIN games g ON g.id=t.game_id ORDER BY t.name COLLATE NOCASE`))));
app.get('/api/teams/:id', wrap(async (req, res) => {
  const t = await db.get('SELECT t.*, g.short_name AS game_short, g.name AS game_name FROM teams t LEFT JOIN games g ON g.id=t.game_id WHERE t.id=?', req.params.id); if (!t) return res.status(404).json({ error: 'Team not found' });
  const members = await db.all(`SELECT p.id, p.gamer_tag, p.gamz_id, p.avatar_hue, tm.role, gi.in_game_id, gi.in_game_name FROM team_members tm JOIN players p ON p.id=tm.player_id
    LEFT JOIN player_game_ids gi ON gi.player_id=p.id AND gi.game_id=? WHERE tm.team_id=? ORDER BY CASE tm.role WHEN 'captain' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, p.gamer_tag`, t.game_id, t.id);
  const history = await historyFor('pa.team_id=?', [t.id]);
  const lb = await LB.get(db);
  const per_game = Object.entries(lb.games).flatMap(([g, rows]) => rows.filter(r => r.type === 'team' && r.id === t.id).map(r => ({ game_id: g, ...r })));
  res.json({ team: t, members, history, per_game, recent: await recentFor(history.map(h => h.id)) });
}));

app.get('/api/overview', wrap(async (req, res) => {
  const counts = await db.get(`SELECT (SELECT COUNT(*) FROM players) players, (SELECT COUNT(*) FROM teams) teams, (SELECT COUNT(*) FROM tournaments WHERE status<>'draft') tournaments,
    (SELECT COUNT(*) FROM tournaments WHERE status='live') live, (SELECT COUNT(*) FROM matches WHERE status='completed') matches_played`);
  const live = await db.all(T_LIST + ` WHERE t.status IN ('live','registration') ORDER BY CASE t.status WHEN 'live' THEN 0 ELSE 1 END, t.starts_at LIMIT 6`);
  const done = await withChampions(await db.all(T_LIST + ` WHERE t.status='completed' ORDER BY t.completed_at DESC LIMIT 4`));
  const recent = await db.all(`SELECT m.id, m.label, m.tournament_id, t.name AS tournament_name, t.game_id, m.winner_id, m.home_id, m.away_id, r.home_score, r.away_score, r.home_pens, r.away_pens,
      COALESCE(hp.gamer_tag, ht.name) AS home_name, COALESCE(ap.gamer_tag, at.name) AS away_name
    FROM matches m JOIN tournaments t ON t.id=m.tournament_id JOIN match_results r ON r.match_id=m.id
    LEFT JOIN participants h ON h.id=m.home_id LEFT JOIN players hp ON hp.id=h.player_id LEFT JOIN teams ht ON ht.id=h.team_id
    LEFT JOIN participants a ON a.id=m.away_id LEFT JOIN players ap ON ap.id=a.player_id LEFT JOIN teams at ON at.id=a.team_id
    WHERE m.status='completed' ORDER BY r.entered_at DESC, m.id DESC LIMIT 6`);
  const lb = await LB.get(db);
  const example = (await db.get('SELECT COUNT(*) c FROM tournaments WHERE is_example=1')).c > 0;
  res.json({ counts, live, completed: done, recent, top: lb.overall.slice(0, 5), example });
}));

// ---------- organizer / admin API ----------
app.post('/api/players', STAFF, wrap(async (req, res) => {
  const tag = String(req.body?.gamer_tag || '').trim(); if (!TAG_RE.test(tag)) return res.status(400).json({ error: 'Gamer tag: 2–24 characters' });
  const p = await IDS.createPlayer(db, { gamer_tag: tag, real_name: req.body.real_name, country: req.body.country });
  if (req.body.game_id && req.body.in_game_id) await IDS.setGameId(db, p.id, req.body.game_id, req.body);
  changed({ kind: 'players' }); res.status(201).json({ ...(await db.get('SELECT * FROM players WHERE id=?', p.id)), game_ids: await IDS.gameIdsOf(db, p.id) });
}));
app.put('/api/players/:id', STAFF, wrap(async (req, res) => {
  const f = {}; for (const k of ['gamer_tag', 'real_name', 'country', 'bio']) if (req.body?.[k] !== undefined) f[k] = String(req.body[k]).trim() || null;
  if (f.gamer_tag !== undefined && !TAG_RE.test(f.gamer_tag || '')) return res.status(400).json({ error: 'Gamer tag: 2–24 characters' });
  const k = Object.keys(f); if (k.length) await db.run(`UPDATE players SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => f[x]), req.params.id);
  changed({ kind: 'players' }); res.json(await db.get('SELECT * FROM players WHERE id=?', req.params.id));
}));
app.put('/api/players/:id/game-ids/:game', STAFF, wrap((req, res) => putGameId(req, res, req.params.id)));
app.delete('/api/players/:id/game-ids/:game', STAFF, wrap((req, res) => delGameId(req, res, req.params.id)));
app.post('/api/teams', STAFF, wrap(async (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim(); if (!TAG_RE.test(name)) return res.status(400).json({ error: 'Team name: 2–24 characters' });
  const r = await db.run('INSERT INTO teams (name, tag, game_id) VALUES (?,?,?)', name, (b.tag || '').trim().slice(0, 6) || null, b.game_id || null);
  const members = Array.isArray(b.members) ? b.members : [];
  if (members.length) await db.batch(members.map((m, i) => ['INSERT OR IGNORE INTO team_members (team_id, player_id, role) VALUES (?,?,?)', [r.lastInsertRowid, Number(m.player_id ?? m), m.role || (i === 0 ? 'captain' : 'member')]]));
  changed({ kind: 'teams' }); res.status(201).json(await db.get('SELECT * FROM teams WHERE id=?', r.lastInsertRowid));
}));
app.put('/api/teams/:id/members', STAFF, wrap(async (req, res) => {
  const members = Array.isArray(req.body?.members) ? req.body.members : [];
  await db.batch([['DELETE FROM team_members WHERE team_id=?', [req.params.id]], ...members.map((m, i) => ['INSERT OR IGNORE INTO team_members (team_id, player_id, role) VALUES (?,?,?)', [req.params.id, Number(m.player_id ?? m), m.role || (i === 0 ? 'captain' : 'member')]])]);
  changed({ kind: 'teams' }); res.json({ ok: true });
}));

const T_FIELDS = ['game_id', 'name', 'format', 'mode', 'status', 'best_of', 'br_match_count', 'points_table', 'kill_points', 'group_count', 'advance_per_group', 'starts_at', 'description', 'prize'];
async function cleanT(b, existing) {
  const o = {}; for (const f of T_FIELDS) if (b[f] !== undefined) o[f] = b[f] === '' ? null : b[f];
  const gid = o.game_id || existing?.game_id, g = await db.get('SELECT * FROM games WHERE id=?', gid);
  if (!g) throw E.err('Choose a game');
  const formats = JSON.parse(g.formats), modes = JSON.parse(g.modes), fmt = o.format || existing?.format, mode = o.mode || existing?.mode;
  if (!formats.includes(fmt)) throw E.err(`${g.short_name} supports: ${formats.join(', ')}`);
  if (!modes.includes(mode)) throw E.err(`${g.short_name} modes: ${modes.join(', ')}`);
  // Games with a series mode (CoDM 5v5, Free Fire Clash Squad 4v4): brackets use only that mode, battle royale never does.
  if (g.series_mode && fmt === 'br_points' && mode === g.series_mode) throw E.err(`${g.short_name} battle royale uses ${modes.filter(m => m !== g.series_mode).join(', ')}`);
  if (g.series_mode && fmt !== 'br_points' && mode !== g.series_mode) throw E.err(`${g.short_name} ${g.series_label || 'bracket'} matches are ${g.series_mode}`);
  if (o.name !== undefined && !String(o.name).trim()) throw E.err('Name is required');
  if (o.best_of != null && ![1, 3, 5, 7].includes(Number(o.best_of))) throw E.err('Best of must be 1, 3, 5 or 7');
  if (o.points_table != null) {
    let a = o.points_table; if (typeof a === 'string') a = a.trim().startsWith('[') ? JSON.parse(a) : a.split(/[ ,;]+/).filter(Boolean).map(Number);
    if (!Array.isArray(a) || !a.length || a.some(n => !Number.isFinite(n) || n < 0)) throw E.err('Points table: comma-separated numbers, 1st place first');
    o.points_table = JSON.stringify(a);
  }
  for (const k of ['best_of', 'br_match_count', 'group_count', 'advance_per_group']) if (o[k] != null) o[k] = Math.max(1, Math.min(64, parseInt(o[k], 10) || 1));
  if (o.kill_points != null) o.kill_points = Math.max(0, Number(o.kill_points) || 0);
  if (!existing && fmt === 'br_points' && o.points_table == null && g.default_points_table) o.points_table = g.default_points_table; // snapshot the game's default
  return o;
}
app.post('/api/tournaments', STAFF, wrap(async (req, res) => {
  const o = await cleanT(req.body || {}); if (!o.name) throw E.err('Name is required');
  o.created_by = req.user.id; o.status = o.status === 'draft' ? 'draft' : 'registration';
  const k = Object.keys(o); const r = await db.run(`INSERT INTO tournaments (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => o[x]));
  changed({ kind: 'tournament', tournament_id: r.lastInsertRowid, game_id: o.game_id }); res.status(201).json(await E.getT(db, r.lastInsertRowid));
}));
app.put('/api/tournaments/:id', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id);
  const started = (await db.get('SELECT COUNT(*) c FROM matches WHERE tournament_id=?', t.id)).c > 0;
  const b = { ...req.body }; if (started) for (const k of ['game_id', 'format', 'mode', 'group_count', 'br_match_count']) delete b[k];
  if (b.status && !['draft', 'registration'].includes(b.status)) delete b.status; // live/completed are automatic
  const o = await cleanT(b, t), k = Object.keys(o);
  if (k.length) await db.run(`UPDATE tournaments SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => o[x]), t.id);
  changed({ kind: 'tournament', tournament_id: t.id, game_id: t.game_id }); res.json(await E.getT(db, t.id));
}));
app.delete('/api/tournaments/:id', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id); await E.resetBracket(db, t.id);
  await db.run('DELETE FROM participants WHERE tournament_id=?', t.id); await db.run('DELETE FROM tournaments WHERE id=?', t.id);
  changed({ kind: 'tournament', tournament_id: t.id, game_id: t.game_id }); res.json({ deleted: t.id });
}));
// Registration requires a linked in-game ID for the tournament's game (every roster member for teams).
// Organizers may override with override_id_check: true — the response then carries a warning.
async function missingGameIds(t, playerId, teamId) {
  if (playerId) return (await db.get('SELECT 1 FROM player_game_ids WHERE player_id=? AND game_id=?', playerId, t.game_id)) ? [] : [(await db.get('SELECT gamer_tag FROM players WHERE id=?', playerId)).gamer_tag];
  const m = await db.all('SELECT p.gamer_tag, gi.in_game_id FROM team_members tm JOIN players p ON p.id=tm.player_id LEFT JOIN player_game_ids gi ON gi.player_id=p.id AND gi.game_id=? WHERE tm.team_id=?', t.game_id, teamId);
  return m.length ? m.filter(x => !x.in_game_id).map(x => x.gamer_tag) : ['(team has no roster)'];
}
app.post('/api/tournaments/:id/participants', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id), b = req.body || {};
  if ((await db.get('SELECT COUNT(*) c FROM matches WHERE tournament_id=?', t.id)).c) throw E.err('Bracket already generated — reset it to change participants');
  const teamMode = !['1v1', 'solo'].includes(t.mode), override = b.override_id_check === true || b.override_id_check === 'true';
  const g = await db.get('SELECT * FROM games WHERE id=?', t.game_id);
  let pid = b.player_id ? Number(b.player_id) : null, tid = b.team_id ? Number(b.team_id) : null, newName = null;
  if (b.new_name) {
    newName = String(b.new_name).trim(); if (!TAG_RE.test(newName)) throw E.err('Name: 2–24 characters');
    if (teamMode) { const ex = await db.get('SELECT id FROM teams WHERE name=?', newName); if (ex) tid = ex.id; }
    else { const ex = await db.get('SELECT id FROM players WHERE gamer_tag=?', newName); if (ex) pid = ex.id; }
  }
  const igid = !teamMode && b.in_game_id ? String(b.in_game_id).trim() : '';
  if (igid) { // validate the in-game ID before creating anything
    const clash = await db.get('SELECT player_id FROM player_game_ids WHERE game_id=? AND in_game_id=?', t.game_id, igid);
    if (clash && clash.player_id !== pid) throw E.err(`That ${g.id_label} is already linked to another gamz player`);
  }
  const willCreate = newName && (teamMode ? !tid : !pid);
  let missing = willCreate ? (teamMode ? ['(new team has no roster)'] : (igid ? [] : [newName])) : (teamMode ? (tid ? await missingGameIds(t, null, tid) : []) : (pid ? (igid ? [] : await missingGameIds(t, pid, null)) : []));
  if (!willCreate && (teamMode ? !tid : !pid)) throw E.err(teamMode ? 'Choose a team' : 'Choose a player');
  if (missing.length && !override) return res.status(409).json({ error: `No ${g.id_label} linked for: ${missing.join(', ')}`, code: 'missing_game_id', missing, id_label: g.id_label });
  if (willCreate) {
    if (teamMode) tid = (await db.run('INSERT INTO teams (name, game_id) VALUES (?,?)', newName, t.game_id)).lastInsertRowid;
    else pid = (await IDS.createPlayer(db, { gamer_tag: newName })).id;
  }
  if (igid) await IDS.setGameId(db, pid, t.game_id, { in_game_id: igid, in_game_name: b.in_game_name });
  const seed = ((await db.get('SELECT MAX(seed) s FROM participants WHERE tournament_id=?', t.id)).s || 0) + 1;
  const r = await db.run('INSERT INTO participants (tournament_id, player_id, team_id, seed) VALUES (?,?,?,?)', t.id, teamMode ? null : pid, teamMode ? tid : null, seed);
  changed({ kind: 'participants', tournament_id: t.id, game_id: t.game_id });
  res.status(201).json({ id: r.lastInsertRowid, ...(missing.length ? { warning: `Registered without a ${g.id_label} for: ${missing.join(', ')}. Opponents won't be able to find them in-game until it is added.` } : {}) });
}));
app.put('/api/tournaments/:id/seeds', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id), order = (req.body?.order || []).map(Number);
  if ((await db.get('SELECT COUNT(*) c FROM matches WHERE tournament_id=?', t.id)).c) throw E.err('Bracket already generated');
  await db.batch(order.map((id, i) => ['UPDATE participants SET seed=? WHERE id=? AND tournament_id=?', [i + 1, id, t.id]]));
  changed({ kind: 'participants', tournament_id: t.id, game_id: t.game_id }); res.json({ ok: true });
}));
app.delete('/api/tournaments/:id/participants/:pid', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id);
  if ((await db.get('SELECT COUNT(*) c FROM matches WHERE tournament_id=?', t.id)).c) throw E.err('Bracket already generated — reset it to change participants');
  await db.run('DELETE FROM participants WHERE id=? AND tournament_id=?', req.params.pid, t.id);
  changed({ kind: 'participants', tournament_id: t.id, game_id: t.game_id }); res.json({ ok: true });
}));
app.post('/api/tournaments/:id/generate', STAFF, wrap(async (req, res) => {
  const d = await E.generate(db, req.params.id, req.body || {});
  changed({ kind: 'bracket', tournament_id: d.tournament.id, game_id: d.tournament.game_id }); res.json(d);
}));
app.post('/api/tournaments/:id/knockout', STAFF, wrap(async (req, res) => {
  const d = await E.generateKnockout(db, req.params.id);
  changed({ kind: 'bracket', tournament_id: d.tournament.id, game_id: d.tournament.game_id }); res.json(d);
}));
app.post('/api/tournaments/:id/reset', STAFF, wrap(async (req, res) => {
  const t = await E.getT(db, req.params.id); await E.resetBracket(db, t.id);
  changed({ kind: 'bracket', tournament_id: t.id, game_id: t.game_id }); res.json({ ok: true });
}));
app.post('/api/matches/:id/result', STAFF, wrap(async (req, res) => {
  const info = await E.recordResult(db, req.params.id, req.body || {}, req.user.id);
  changed({ kind: 'result', match_id: +req.params.id, ...info }); res.json(await E.loadTournament(db, info.tournament_id));
}));
app.post('/api/matches/:id/br-result', STAFF, wrap(async (req, res) => {
  const info = await E.recordBr(db, req.params.id, req.body?.rows, req.user.id);
  changed({ kind: 'result', match_id: +req.params.id, ...info }); res.json(await E.loadTournament(db, info.tournament_id));
}));
app.delete('/api/matches/:id/result', STAFF, wrap(async (req, res) => {
  const info = await E.clearResult(db, req.params.id);
  changed({ kind: 'result', match_id: +req.params.id, ...info }); res.json(await E.loadTournament(db, info.tournament_id));
}));

// Organizer accounts (admin only)
app.get('/api/users', need('admin'), wrap(async (req, res) => res.json(await db.all(`SELECT u.id, u.username, u.role, u.player_id, u.created_at, p.gamer_tag FROM users u LEFT JOIN players p ON p.id=u.player_id ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'organizer' THEN 1 ELSE 2 END, u.username`))));
app.post('/api/users', need('admin'), wrap(async (req, res) => {
  const username = String(req.body?.username || '').trim(), password = String(req.body?.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) throw E.err('Username: 3–24 letters, numbers, _ . -');
  if (password.length < 8) throw E.err('Password must be at least 8 characters');
  await assertUsernameAvailable(username);
  const r = await db.run(`INSERT INTO users (username,password_hash,role) VALUES (?,?,'organizer')`, username, hashPw(password));
  res.status(201).json({ id: r.lastInsertRowid, username, role: 'organizer' });
}));
app.put('/api/users/:id/role', need('admin'), wrap(async (req, res) => {
  const role = req.body?.role; if (!['organizer', 'player'].includes(role)) throw E.err('Role must be organizer or player');
  const u = await db.get('SELECT * FROM users WHERE id=?', req.params.id); if (!u) throw E.err('User not found', 404); if (u.role === 'admin') throw E.err('The admin account cannot be changed here');
  await db.run('UPDATE users SET role=? WHERE id=?', role, u.id); res.json({ ok: true });
}));
app.delete('/api/users/:id', need('admin'), wrap(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', req.params.id); if (!u) throw E.err('User not found', 404); if (u.role === 'admin') throw E.err('The admin account cannot be deleted');
  await db.run('DELETE FROM users WHERE id=?', u.id); res.json({ deleted: u.id });
}));

// System page (admin only)
const STARTED = Date.now();
app.get('/api/system', need('admin'), wrap(async (req, res) => {
  const tables = ['games', 'players', 'teams', 'team_members', 'tournaments', 'participants', 'matches', 'match_results', 'br_match_results', 'users', 'sessions'];
  const counts = {}; for (const t of tables) counts[t] = (await db.get(`SELECT COUNT(*) c FROM ${t}`)).c;
  const migrations = await db.all('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  const example = (await db.get('SELECT (SELECT COUNT(*) FROM tournaments WHERE is_example=1) + (SELECT COUNT(*) FROM players WHERE is_example=1) c')).c;
  const lb = await LB.get(db);
  res.json({ db: describe(), db_mode: IS_REMOTE ? 'turso' : 'local-file', production: PROD, node: process.version, uptime_s: Math.round((Date.now() - STARTED) / 1000),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576), live_viewers: clients.size, signup_open: ALLOW_SIGNUP, admin_user: ADMIN_USER,
    counts, migrations, example_rows: example, leaderboard_version: lb.version, leaderboard_computed_at: lb.computed_at });
}));
app.post('/api/system/clear-example-data', need('admin'), wrap(async (req, res) => {
  const { clearExample } = require('./db/seed');
  await clearExample(db); changed({ kind: 'all' }); res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

async function ensureAdmin() {
  const u = await db.get('SELECT * FROM users WHERE role=?', 'admin');
  if (!u) await db.run(`INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')`, ADMIN_USER, hashPw(ADMIN_PASSWORD));
  else if (u.username !== ADMIN_USER || !checkPw(ADMIN_PASSWORD, u.password_hash)) { await db.run('UPDATE users SET username=?, password_hash=? WHERE id=?', ADMIN_USER, hashPw(ADMIN_PASSWORD), u.id); await db.run('DELETE FROM sessions WHERE user_id=?', u.id); }
}

(async () => {
  const applied = await migrate(db);
  await ensureAdmin();
  app.listen(PORT, () => {
    console.log(`gamz tournaments on http://localhost:${PORT}  (db: ${describe()}${applied.length ? ', migrated ' + applied.join(', ') : ''})`);
    if (!process.env.ADMIN_PASSWORD) console.log(`Local admin login: ${ADMIN_USER} / password in .admin-password.local`);
  });
})().catch(e => { console.error('Startup failed:', e); process.exit(1); });
