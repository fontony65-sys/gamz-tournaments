// Automated verification: bracket generation (byes), auto-advance, double elimination, football rules,
// PUBG/BR points, league tables, leaderboard recompute, auth (sessions, roles, rate limit) and SSE live updates.
// Uses throw-away local database files only. Run: npm run verify
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const assert = require('assert/strict');
// Safety: never touch any configured database — force a temporary local file.
delete process.env.GAMZ_DATABASE_URL; delete process.env.GAMZ_DATABASE_TOKEN;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamz-verify-'));
process.env.GAMZ_LOCAL_DB_FILE = path.join(TMP, 'unit.db');
const { open, migrate, IS_REMOTE } = require('../db');
const E = require('../lib/engine'), B = require('../lib/bracket'), SC = require('../lib/scoring'), LB = require('../lib/leaderboard');

let pass = 0, fail = 0; const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push('  ✓ ' + name); }
  catch (e) { fail++; results.push('  ✗ ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); }
}
let rs = 7; const rnd = () => (rs = (rs * 16807) % 2147483647) / 2147483647;

let db;
async function mkTournament(o) {
  const k = Object.keys(o); const r = await db.run(`INSERT INTO tournaments (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...k.map(x => o[x])); return r.lastInsertRowid;
}
let tagN = 0;
async function players(n) { const ids = []; for (let i = 0; i < n; i++) ids.push((await db.run('INSERT INTO players (gamer_tag) VALUES (?)', 'P' + (++tagN))).lastInsertRowid); return ids; }
async function teams(n) { const ids = []; for (let i = 0; i < n; i++) ids.push((await db.run('INSERT INTO teams (name) VALUES (?)', 'T' + (++tagN))).lastInsertRowid); return ids; }
async function register(tid, ids, team = false) { let s = 1; for (const id of ids) await db.run(`INSERT INTO participants (tournament_id, ${team ? 'team_id' : 'player_id'}, seed) VALUES (?,?,?)`, tid, id, s++); return (await E.participantsOf(db, tid)).map(p => p.id); }
const matches = tid => db.all('SELECT * FROM matches WHERE tournament_id=? ORDER BY id', tid);
async function playAll(tid, pick = m => (rnd() < 0.5 ? 'home' : 'away'), bo = 1) {
  for (let i = 0; i < 300; i++) {
    const m = await db.get(`SELECT * FROM matches WHERE tournament_id=? AND status='ready' AND stage<>'br' ORDER BY id LIMIT 1`, tid); if (!m) return;
    const need = Math.floor(bo / 2) + 1, w = pick(m);
    await E.recordResult(db, m.id, w === 'home' ? { home_score: need, away_score: 0 } : { home_score: 0, away_score: need });
  }
  throw new Error('playAll did not finish');
}

(async () => {
  assert.equal(IS_REMOTE, false, 'verify must run on a local file DB');
  db = open(); await migrate(db);

  console.log('Bracket generation');
  await test('standard seed order (1 and 2 only meet in the final)', () => { assert.deepEqual(B.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]); assert.deepEqual(B.seedOrder(4), [1, 4, 2, 3]); });
  await test('byes for non-power-of-2 counts go to the top seeds (n = 3, 5, 6, 7, 12, 13)', () => {
    for (const n of [3, 5, 6, 7, 12, 13]) {
      const ids = Array.from({ length: n }, (_, i) => i + 1), slots = B.firstRoundSlots(ids), S2 = B.nextPow2(n);
      assert.equal(slots.length, S2); assert.equal(slots.filter(x => x == null).length, S2 - n, `byes for ${n}`);
      for (let m = 0; m < S2 / 2; m++) { const a = slots[2 * m], b = slots[2 * m + 1]; assert.ok(a != null || b != null, 'no empty match'); if (a == null || b == null) assert.ok((a ?? b) <= S2 - n, `bye given to top seed (n=${n})`); }
      assert.deepEqual([...slots].filter(Boolean).sort((a, b) => a - b), ids);
    }
  });
  await test('as_listed draw keeps consecutive pairs together and still spreads byes', () => {
    const s = B.firstRoundSlots([11, 12, 13, 14, 15, 16], 'as_listed');
    assert.deepEqual(s, [11, null, 12, 13, 14, null, 15, 16]);
  });
  await test('single elimination with 6 players: 2 bye matches auto-advance seeds 1 & 2', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'SE6', format: 'single_elim', mode: '1v1' }), p = await register(t, await players(6));
    await E.generate(db, t);
    const ms = await matches(t), byes = ms.filter(m => m.status === 'bye');
    assert.equal(ms.length, 7); assert.equal(byes.length, 2);
    assert.deepEqual(byes.map(m => m.winner_id).sort(), [p[0], p[1]].sort());
    const r2 = ms.filter(m => m.round === 2); assert.ok(r2.some(m => m.home_id === p[0]) && r2.some(m => m.home_id === p[1]), 'seeds 1 and 2 already placed in semi-finals');
    assert.equal(ms.filter(m => m.round === 1 && m.status === 'ready').length, 2);
  });
  await test('single elimination with 13 players generates 15 matches, 3 byes, completes with ranks 1/2/3/3', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'SE13', format: 'single_elim', mode: '1v1' }); await register(t, await players(13));
    await E.generate(db, t); assert.equal((await matches(t)).length, 15); assert.equal((await matches(t)).filter(m => m.status === 'bye').length, 3);
    await playAll(t);
    const d = await E.loadTournament(db, t), ranks = d.participants.map(x => x.rank).sort((a, b) => a - b);
    assert.equal(d.tournament.status, 'completed'); assert.deepEqual(ranks.slice(0, 4), [1, 2, 3, 3]); assert.ok(ranks.every(Boolean));
  });

  console.log('Auto-advance & corrections');
  await test('entering a result moves the winner into the next match; clearing it pulls them back', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'ADV', format: 'single_elim', mode: '1v1' }); await register(t, await players(4));
    await E.generate(db, t); const [m1] = await matches(t);
    await E.recordResult(db, m1.id, { home_score: 3, away_score: 1 });
    let fin = await db.get('SELECT * FROM matches WHERE id=?', m1.next_match_id); assert.equal(fin[m1.next_slot + '_id'], m1.home_id);
    await E.recordResult(db, m1.id, { home_score: 0, away_score: 2 }); // correction swaps winner
    fin = await db.get('SELECT * FROM matches WHERE id=?', m1.next_match_id); assert.equal(fin[m1.next_slot + '_id'], m1.away_id);
    await E.clearResult(db, m1.id);
    fin = await db.get('SELECT * FROM matches WHERE id=?', m1.next_match_id); assert.equal(fin[m1.next_slot + '_id'], null); assert.equal(fin.status, 'pending');
  });
  await test('cannot change a result once a later match fed by it has a result', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'LOCK', format: 'single_elim', mode: '1v1' }); await register(t, await players(4));
    await E.generate(db, t); await playAll(t, () => 'home'); const [m1] = await matches(t);
    await assert.rejects(E.recordResult(db, m1.id, { home_score: 0, away_score: 1 }), /already has a result/);
  });
  await test('football knockout draw requires a penalty winner; league draw is allowed', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'PEN', format: 'single_elim', mode: '1v1' }); await register(t, await players(2));
    await E.generate(db, t); const [m] = await matches(t);
    await assert.rejects(E.recordResult(db, m.id, { home_score: 1, away_score: 1 }), /penalt/i);
    await assert.rejects(E.recordResult(db, m.id, { home_score: 1, away_score: 1, home_pens: 4, away_pens: 4 }), /penalt/i);
    await E.recordResult(db, m.id, { home_score: 1, away_score: 1, home_pens: 3, away_pens: 5 });
    const d = await E.loadTournament(db, t); assert.equal(d.matches[0].winner_id, m.away_id); assert.equal(d.tournament.status, 'completed');
    const l = await mkTournament({ game_id: 'efootball', name: 'LG', format: 'league', mode: '1v1' }); await register(l, await players(4)); await E.generate(db, l);
    const [lm] = await matches(l); await E.recordResult(db, lm.id, { home_score: 2, away_score: 2 });
    const ld = await E.loadTournament(db, l), row = ld.standings.groups[0].table.find(x => x.participant_id === lm.home_id);
    assert.equal(row.D, 1); assert.equal(row.Pts, 1);
  });
  await test('CoDM best-of-3 series validation (2-1 ok, 2-2 / 1-0 rejected)', async () => {
    const t = await mkTournament({ game_id: 'codm', name: 'BO3', format: 'single_elim', mode: '5v5', best_of: 3 }); await register(t, await teams(2), true);
    await E.generate(db, t); const [m] = await matches(t); assert.equal(m.best_of, 3);
    await assert.rejects(E.recordResult(db, m.id, { home_score: 2, away_score: 2 }), /Best of 3/);
    await assert.rejects(E.recordResult(db, m.id, { home_score: 1, away_score: 0 }), /Best of 3/);
    await E.recordResult(db, m.id, { home_score: 1, away_score: 2 }); assert.equal((await db.get('SELECT winner_id FROM matches WHERE id=?', m.id)).winner_id, m.away_id);
  });

  console.log('Double elimination');
  await test('8 teams: structure is 7 WB + 6 LB + grand final + reset', async () => {
    const t = await mkTournament({ game_id: 'codm', name: 'DE8s', format: 'double_elim', mode: '5v5' }); await register(t, await teams(8), true); await E.generate(db, t);
    const ms = await matches(t), c = s => ms.filter(m => m.stage === s).length;
    assert.equal(c('winners'), 7); assert.equal(c('losers'), 6); assert.equal(c('grand_final'), 1); assert.equal(c('grand_final_reset'), 1);
    assert.ok(ms.filter(m => m.stage === 'winners').every(m => m.loser_next_match_id), 'every WB match drops its loser');
  });
  for (const n of [8, 6, 5, 3, 16]) await test(`${n} teams, random results: nobody is eliminated before 2 losses, champion has ≤1 loss, tournament completes`, async () => {
    for (let rep = 0; rep < 4; rep++) {
      const t = await mkTournament({ game_id: 'codm', name: 'DE' + n, format: 'double_elim', mode: '5v5' }); const p = await register(t, await teams(n), true); await E.generate(db, t);
      await playAll(t);
      const d = await E.loadTournament(db, t), ms = d.matches.filter(m => m.status === 'completed');
      assert.equal(d.tournament.status, 'completed', 'completed');
      const losses = new Map(p.map(x => [x, 0])); for (const m of ms) losses.set(m.loser_id, losses.get(m.loser_id) + 1);
      const champ = d.participants.find(x => x.rank === 1);
      assert.ok(champ, 'has champion'); assert.ok(losses.get(champ.id) <= 1, 'champion ≤1 loss');
      for (const [pid, l] of losses) if (pid !== champ.id) assert.equal(l, 2, `participant ${pid} eliminated after exactly 2 losses`);
      assert.equal(d.participants.filter(x => x.rank === 2).length, 1);
      assert.ok(d.participants.every(x => x.rank), 'everyone ranked');
    }
  });
  await test('grand final: WB champion wins → no reset; LB champion wins → bracket reset is played', async () => {
    for (const lbWins of [false, true]) {
      const t = await mkTournament({ game_id: 'codm', name: 'GF', format: 'double_elim', mode: '5v5' }); await register(t, await teams(4), true); await E.generate(db, t);
      await playAll(t, m => m.stage === 'grand_final' ? (lbWins ? 'away' : 'home') : 'home');
      const ms = await matches(t), gf = ms.find(m => m.stage === 'grand_final'), rs2 = ms.find(m => m.stage === 'grand_final_reset');
      if (!lbWins) { assert.equal(rs2.status, 'void'); assert.equal(gf.winner_id, gf.home_id); }
      else { assert.equal(rs2.status, 'completed'); assert.equal(rs2.home_id, gf.home_id); assert.equal(rs2.away_id, gf.away_id); }
      assert.equal((await E.getT(db, t)).status, 'completed');
    }
  });

  console.log('Battle royale (PUBG Mobile / CoDM BR)');
  await test('PMCO-style placement points + kill points', () => {
    assert.deepEqual(SC.brPoints(1, 7), { placement_points: 15, kill_points: 7, total: 22 });
    assert.equal(SC.brPoints(2, 0).total, 12); assert.equal(SC.brPoints(8, 3).total, 4); assert.equal(SC.brPoints(13, 2).total, 2); assert.equal(SC.brPoints(40, 0).total, 0);
    assert.equal(SC.brPoints(1, 4, [10, 6, 5], 2).total, 18, 'custom table & kill points');
  });
  await test('BR standings across matches incl. tie-break on chicken dinners', async () => {
    const t = await mkTournament({ game_id: 'pubgm', name: 'BR', format: 'br_points', mode: 'squad', br_match_count: 2 }); const p = await register(t, await teams(3), true);
    await E.generate(db, t); const [m1, m2] = await matches(t);
    assert.equal(m1.map_name, 'Erangel');
    // A: 1st (15) + 0 kills, then 3rd (10) + 0 = 25 ; B: 2nd (12) + 3, then 2nd (12) - total 27 ; C: 3rd (10)+5 then 1st(15)+0 = 30
    await E.recordBr(db, m1.id, [{ participant_id: p[0], placement: 1, kills: 0 }, { participant_id: p[1], placement: 2, kills: 3 }, { participant_id: p[2], placement: 3, kills: 5 }]);
    await E.recordBr(db, m2.id, [{ participant_id: p[0], placement: 3, kills: 0 }, { participant_id: p[1], placement: 2, kills: 0 }, { participant_id: p[2], placement: 1, kills: 0 }]);
    const d = await E.loadTournament(db, t);
    assert.deepEqual(d.standings.br.map(s => [s.participant_id, s.total]), [[p[2], 30], [p[1], 27], [p[0], 25]]);
    assert.equal(d.standings.br[0].wwcd, 1); assert.equal(d.standings.br[0].kills, 5);
    assert.equal(d.tournament.status, 'completed'); assert.equal(d.participants.find(x => x.id === p[2]).rank, 1);
    const tie = SC.brStandings([{ id: 1, name: 'a' }, { id: 2, name: 'b' }], [{ participant_id: 1, match_id: 9, placement: 2, kills: 3 }, { participant_id: 2, match_id: 9, placement: 1, kills: 0 }], {});
    assert.equal(tie[0].participant_id, 2, '15 vs 15 → chicken dinner wins the tie');
    await assert.rejects(E.recordBr(db, m1.id, [{ participant_id: p[0], placement: 1, kills: 0 }, { participant_id: p[1], placement: 1, kills: 0 }]), /share placement/);
  });

  console.log('League & league + knockout (eFootball)');
  await test('round robin: n(n-1)/2 fixtures, everyone plays everyone once (odd count has rest days)', () => {
    for (const n of [4, 5, 8]) { const r = B.roundRobin(Array.from({ length: n }, (_, i) => i + 1)).flat(); assert.equal(r.length, n * (n - 1) / 2); assert.equal(new Set(r.map(([a, b]) => [a, b].sort().join('-'))).size, r.length); }
  });
  await test('league table W/D/L, goal difference; knockout seeded A1, B1, A2, B2', async () => {
    const t = await mkTournament({ game_id: 'efootball', name: 'LKO', format: 'league_knockout', mode: '1v1', group_count: 2, advance_per_group: 2 }); await register(t, await players(8));
    await E.generate(db, t); await assert.rejects(E.generateKnockout(db, t), /Finish all league/);
    for (const m of (await matches(t))) await E.recordResult(db, m.id, { home_score: m.home_id % 3, away_score: m.away_id % 2 });
    let d = await E.loadTournament(db, t);
    assert.equal(d.standings.groups.length, 2); for (const g of d.standings.groups) { assert.equal(g.table.length, 4); for (const r of g.table) { assert.equal(r.P, 3); assert.equal(r.Pts, 3 * r.W + r.D); assert.equal(r.GD, r.GF - r.GA); } }
    await E.generateKnockout(db, t); d = await E.loadTournament(db, t);
    const ko = d.matches.filter(m => m.stage === 'winners' && m.round === 1), A = d.standings.groups[0].table, Bt = d.standings.groups[1].table;
    assert.equal(ko.length, 2); assert.deepEqual([ko[0].home_id, ko[0].away_id], [A[0].participant_id, Bt[1].participant_id]); assert.deepEqual([ko[1].home_id, ko[1].away_id], [Bt[0].participant_id, A[1].participant_id]);
    await playAll(t); d = await E.loadTournament(db, t); assert.equal(d.tournament.status, 'completed'); assert.equal(d.participants.filter(x => x.rank).length, 8);
  });

  console.log('Leaderboard recompute');
  await test('per-game and overall leaderboards recompute from results (wins, goals, placement points)', async () => {
    const t = await mkTournament({ game_id: 'dls', name: 'LBT', format: 'single_elim', mode: '1v1' }); const pl = await players(2); const p = await register(t, pl); await E.generate(db, t);
    const before = await LB.compute(db); assert.equal(before.games.dls.find(r => r.id === pl[0]).wins, 0);
    const [m] = await matches(t); await E.recordResult(db, m.id, { home_score: 3, away_score: 1 });
    const after = await LB.compute(db), w = after.games.dls.find(r => r.id === pl[0]), l = after.games.dls.find(r => r.id === pl[1]);
    assert.equal(w.wins, 1); assert.equal(w.gd, 2); assert.equal(w.titles, 1); assert.equal(w.placement_points, 100); assert.equal(w.score, 100 + 3);
    assert.equal(l.placement_points, 70); assert.equal(l.losses, 1);
    const ow = after.overall.find(r => r.id === pl[0]); assert.equal(ow.points, 100 + 2); assert.equal(ow.titles, 1);
    assert.ok(after.version > before.version);
    LB.invalidate(); const cached = await LB.get(db); assert.equal((await LB.get(db)).version, cached.version, 'cached until invalidated');
  });
  await test('team results are credited to every team member on the overall board', async () => {
    const [ta, tb] = await teams(2), [a1, a2, b1] = await players(3);
    await db.run('INSERT INTO team_members (team_id, player_id) VALUES (?,?),(?,?),(?,?)', ta, a1, ta, a2, tb, b1);
    const t = await mkTournament({ game_id: 'codm', name: 'TM', format: 'single_elim', mode: '5v5', best_of: 1 }); await register(t, [ta, tb], true); await E.generate(db, t);
    const [m] = await matches(t); await E.recordResult(db, m.id, { home_score: 1, away_score: 0 });
    const lb = await LB.compute(db); for (const id of [a1, a2]) assert.equal(lb.overall.find(r => r.id === id).titles >= 1, true); assert.equal(lb.overall.find(r => r.id === b1).titles, 0);
  });
  db.close();

  // ---------------- HTTP server: auth + SSE ----------------
  const PORT = 3900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`, ADMIN_PASSWORD = 'verify-admin-pass-123';
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), ADMIN_PASSWORD, GAMZ_LOCAL_DB_FILE: path.join(TMP, 'server.db'),
    // Decoys: the app must ignore other apps' DB variables entirely.
    TURSO_DATABASE_URL: 'libsql://decoy-must-not-be-used.invalid', TURSO_AUTH_TOKEN: 'decoy' };
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50 && !log.includes('gamz tournaments on'); i++) await new Promise(r => setTimeout(r, 100));
  const req = async (method, p, body, cookie) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j, cookie: (r.headers.get('set-cookie') || '').split(';')[0], rawCookie: r.headers.get('set-cookie') || '' };
  };
  console.log('Auth & server');
  let admin;
  try {
    await test('server uses the local file DB and ignores TURSO_* variables', async () => { const r = await req('GET', '/api/health'); assert.equal(r.status, 200); assert.equal(r.body.db, 'local-file'); });
    await test('public pages need no login; writes need login (401)', async () => {
      assert.equal((await req('GET', '/api/tournaments')).status, 200); assert.equal((await req('GET', '/api/leaderboard')).status, 200);
      assert.equal((await req('POST', '/api/tournaments', { game_id: 'efootball', name: 'x', format: 'single_elim', mode: '1v1' })).status, 401);
      assert.equal((await req('GET', '/api/system')).status, 401);
    });
    await test('admin login (from ADMIN_PASSWORD) issues an HttpOnly session cookie stored hashed in the DB', async () => {
      assert.equal((await req('POST', '/api/login', { username: 'admin', password: 'wrong' })).status, 401);
      const r = await req('POST', '/api/login', { username: 'admin', password: ADMIN_PASSWORD }); assert.equal(r.status, 200); assert.equal(r.body.user.role, 'admin'); admin = r.cookie;
      assert.match(admin, /^gamz_session=[a-f0-9]{64}$/); assert.match(r.rawCookie, /HttpOnly/); assert.match(r.rawCookie, /SameSite=Lax/);
      const sdb = require('@libsql/client').createClient({ url: 'file:' + childEnv.GAMZ_LOCAL_DB_FILE });
      const rows = (await sdb.execute('SELECT token_hash FROM sessions')).rows.map(x => x[0]); sdb.close();
      assert.ok(rows.length >= 1); assert.ok(!rows.includes(admin.split('=')[1]), 'raw token not stored');
      assert.equal((await req('GET', '/api/me', null, admin)).body.user.username, 'admin');
    });
    await test('roles: organizer can run tournaments but not the System page; player accounts cannot run tournaments', async () => {
      assert.equal((await req('POST', '/api/users', { username: 'org1', password: 'organizer-pass' }, admin)).status, 201);
      const org = (await req('POST', '/api/login', { username: 'org1', password: 'organizer-pass' })).cookie;
      assert.equal((await req('POST', '/api/tournaments', { game_id: 'pubgm', name: 'Org BR', format: 'br_points', mode: 'squad' }, org)).status, 201);
      assert.equal((await req('GET', '/api/system', null, org)).status, 403);
      const su = await req('POST', '/api/signup', { username: 'player1', password: 'player-pass-1', gamer_tag: 'NovaPlayer' }); assert.equal(su.status, 201);
      assert.equal((await req('POST', '/api/tournaments', { game_id: 'efootball', name: 'x', format: 'single_elim', mode: '1v1' }, su.cookie)).status, 403);
      assert.equal((await req('PUT', '/api/me', { theme: 'light', bio: 'hi' }, su.cookie)).body.user.theme, 'light');
      assert.equal((await req('POST', '/api/tournaments', { game_id: 'efootball', name: 'bad', format: 'br_points', mode: '1v1' }, admin)).status, 400, 'format validated per game');
    });
    await test('logout deletes the session', async () => {
      const c = (await req('POST', '/api/login', { username: 'org1', password: 'organizer-pass' })).cookie;
      await req('POST', '/api/logout', null, c); assert.equal((await req('GET', '/api/me', null, c)).body.user, null);
    });
    await test('SSE: viewers receive an update event when a result is entered, and the leaderboard reflects it', async () => {
      const t = (await req('POST', '/api/tournaments', { game_id: 'efootball', name: 'SSE Cup', format: 'single_elim', mode: '1v1' }, admin)).body;
      for (const n of ['SseA', 'SseB']) assert.equal((await req('POST', `/api/tournaments/${t.id}/participants`, { new_name: n }, admin)).status, 201);
      const g = await req('POST', `/api/tournaments/${t.id}/generate`, {}, admin); assert.equal(g.status, 200);
      const m = g.body.matches[0];
      const events = []; let hello = false;
      const sse = http.get(BASE + '/api/stream', res => { assert.equal(res.headers['content-type'], 'text/event-stream'); res.setEncoding('utf8'); res.on('data', c => { if (c.includes('event: hello')) hello = true; for (const b of c.split('\n\n')) if (b.startsWith('event: update')) events.push(JSON.parse(b.split('data: ')[1])); }); });
      for (let i = 0; i < 30 && !hello; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(hello, 'connected');
      const r = await req('POST', `/api/matches/${m.id}/result`, { home_score: 2, away_score: 0 }, admin); assert.equal(r.status, 200);
      for (let i = 0; i < 40 && !events.some(e => e.match_id === m.id); i++) await new Promise(r2 => setTimeout(r2, 50));
      sse.destroy();
      const ev = events.find(e => e.match_id === m.id); assert.ok(ev, 'update event received'); assert.equal(ev.kind, 'result'); assert.equal(ev.tournament_id, t.id);
      const lb = await req('GET', '/api/leaderboard?game=efootball'); assert.equal(lb.body.rows[0].name, 'SseA'); assert.equal(lb.body.rows[0].titles, 1);
    });
    await test('login rate limit: 10 failed attempts → 429', async () => {
      let last; for (let i = 0; i < 11; i++) last = await req('POST', '/api/login', { username: 'admin', password: 'nope' + i });
      assert.equal(last.status, 429);
    });
  } finally { srv.kill(); }
  await test('production refuses to start without ADMIN_PASSWORD', async () => {
    const env = { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(PORT + 1), GAMZ_LOCAL_DB_FILE: path.join(TMP, 'prod.db') };
    const code = await new Promise(r => { const c = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); c.on('exit', r); setTimeout(() => { c.kill(); r('still running'); }, 4000); });
    assert.equal(code, 1);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
