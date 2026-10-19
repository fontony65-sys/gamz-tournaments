// Automated verification: bracket generation (byes), auto-advance, double elimination, football rules,
// PUBG/BR points, league tables, leaderboard recompute, gamz IDs + in-game IDs (uniqueness, registration gate, search),
// auth (sessions, roles, rate limit) and SSE live updates.
// Uses throw-away local database files only. Run: npm run verify
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const assert = require('assert/strict');
// Safety: never touch any configured database — force a temporary local file.
delete process.env.GAMZ_DATABASE_URL; delete process.env.GAMZ_DATABASE_TOKEN;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gamz-verify-'));
process.env.GAMZ_LOCAL_DB_FILE = path.join(TMP, 'unit.db');
const { open, migrate, IS_REMOTE } = require('../db');
const E = require('../lib/engine'), B = require('../lib/bracket'), SC = require('../lib/scoring'), LB = require('../lib/leaderboard'), IDS = require('../lib/ids');

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
async function players(n) { const ids = []; for (let i = 0; i < n; i++) ids.push((await IDS.createPlayer(db, { gamer_tag: 'P' + (++tagN) })).id); return ids; }
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

  console.log('gamz IDs & in-game IDs');
  await test('gamz IDs: GMZ- + 6 chars from the unambiguous alphabet (no 0/O/1/I/L), 3000 generated are distinct', () => {
    assert.equal(IDS.ALPHABET.length, 31); assert.ok(!/[01OIL]/.test(IDS.ALPHABET));
    const seen = new Set(); for (let i = 0; i < 3000; i++) { const id = IDS.makeGamzId(); assert.match(id, IDS.GAMZ_ID_RE); seen.add(id); }
    assert.equal(seen.size, 3000);
  });
  await test('every created player gets a unique gamz ID; a collision is detected and a fresh ID is drawn', async () => {
    const [a] = await players(1), taken = (await db.get('SELECT gamz_id FROM players WHERE id=?', a)).gamz_id;
    // rng that first replays the taken ID's characters, then yields "222222"
    const seq = [...taken.slice(4)].map(c => IDS.ALPHABET.indexOf(c)); let k = 0; const rng = () => (k < seq.length ? seq[k++] : 0);
    const b = await IDS.createPlayer(db, { gamer_tag: 'Collider' }, rng);
    assert.equal(b.gamz_id, 'GMZ-222222'); assert.notEqual(b.gamz_id, taken);
    await assert.rejects(db.run('INSERT INTO players (gamer_tag, gamz_id) VALUES (?,?)', 'Dup', taken), /UNIQUE/, 'unique index is the final guard');
  });
  await test('gamz IDs are immutable (DB trigger) and the migration backfills rows that had none', async () => {
    const [a] = await players(1);
    await assert.rejects(db.run("UPDATE players SET gamz_id='GMZ-333333' WHERE id=?", a), /immutable/);
    for (const t of ['OldA', 'OldB', 'OldC']) await db.run('INSERT INTO players (gamer_tag) VALUES (?)', t); // legacy rows without an ID
    assert.ok((await IDS.backfillGamzIds(db)) >= 3);
    assert.equal((await db.get('SELECT COUNT(*) c FROM players WHERE gamz_id IS NULL')).c, 0);
    const all = (await db.all('SELECT gamz_id FROM players')).map(r => r.gamz_id); assert.equal(new Set(all).size, all.length); all.forEach(x => assert.match(x, IDS.GAMZ_ID_RE));
  });
  await test('gamz ID search normalisation: gmz-7k3q9p, GMZ 7K3Q9P, 7k3q9p → GMZ-7K3Q9P; ambiguous chars rejected', () => {
    for (const q of ['gmz-7k3q9p', 'GMZ 7K3Q9P', '7k3q9p', ' gmz7K3Q9P ']) assert.equal(IDS.normalizeGamzId(q), 'GMZ-7K3Q9P');
    for (const q of ['GMZ-7K3Q9O', 'GMZ-7K3Q91', 'hello', 'GMZ-7K3']) assert.equal(IDS.normalizeGamzId(q), null);
  });
  await test('player_game_ids: one ID per player per game (upsert), an in-game ID belongs to one player per game (case-insensitive)', async () => {
    const [a, b] = await players(2);
    await IDS.setGameId(db, a, 'efootball', { in_game_id: 'ABC-123-456', in_game_name: 'Alpha' });
    await assert.rejects(IDS.setGameId(db, b, 'efootball', { in_game_id: 'abc-123-456' }), /already linked to another gamz player/);
    await IDS.setGameId(db, b, 'dls', { in_game_id: 'ABC-123-456' }); // same string in another game is fine
    await IDS.setGameId(db, a, 'efootball', { in_game_id: 'NEW-999-000' }); // edit = replace
    assert.deepEqual((await IDS.gameIdsOf(db, a)).map(x => [x.game_id, x.in_game_id]), [['efootball', 'NEW-999-000']]);
    await assert.rejects(db.run("INSERT INTO player_game_ids (player_id, game_id, in_game_id) VALUES (?, 'efootball', 'X-1')", a), /UNIQUE/);
    await assert.rejects(db.run("INSERT INTO player_game_ids (player_id, game_id, in_game_id) VALUES (?, 'dls', 'abc-123-456')", a), /UNIQUE/);
    await assert.rejects(IDS.setGameId(db, a, 'pubgm', { in_game_id: 'x' }), /3–40/);
    await IDS.removeGameId(db, a, 'efootball'); assert.equal((await IDS.gameIdsOf(db, a)).length, 0);
  });
  await test("participants carry the in-game ID for the tournament's game; team entrants list members with their IDs", async () => {
    const [p1, p2] = await players(2); await IDS.setGameId(db, p1, 'dls', { in_game_id: 'DLS-P1', in_game_name: 'P1 FC' }); await IDS.setGameId(db, p1, 'codm', { in_game_id: 'CODM-P1' });
    const t = await mkTournament({ game_id: 'dls', name: 'IDs', format: 'single_elim', mode: '1v1' }); await register(t, [p1, p2]);
    const d = await E.loadTournament(db, t), x = d.participants.find(p => p.player_id === p1);
    assert.equal(x.in_game_id, 'DLS-P1'); assert.equal(x.in_game_name, 'P1 FC'); assert.match(x.gamz_id, IDS.GAMZ_ID_RE);
    assert.equal(d.participants.find(p => p.player_id === p2).in_game_id, null);
    const [tm] = await teams(1); await db.run('INSERT INTO team_members (team_id, player_id, role) VALUES (?,?,?),(?,?,?)', tm, p1, 'captain', tm, p2, 'member');
    const t2 = await mkTournament({ game_id: 'codm', name: 'IDs T', format: 'single_elim', mode: '5v5', best_of: 1 }); await register(t2, [tm], true);
    const mem = (await E.loadTournament(db, t2)).participants[0].members;
    assert.deepEqual(mem.map(m => [m.player_id, m.in_game_id]), [[p1, 'CODM-P1'], [p2, null]]);
  });

  console.log('Free Fire');
  await test('Free Fire migration upgrades a pre-FF database in place (data kept) and is idempotent', async () => {
    const f = path.join(TMP, 'upgrade.db'), odb = open('file:' + f);
    await odb.run(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    await odb.run("INSERT INTO schema_migrations(name) VALUES ('006_free_fire.js')"); await migrate(odb); // = a database from before Free Fire
    await odb.run("DELETE FROM schema_migrations WHERE name='006_free_fire.js'");
    assert.equal(await odb.get("SELECT 1 FROM games WHERE id='ff'"), undefined);
    await odb.run("INSERT INTO players (gamer_tag, gamz_id) VALUES ('RealPlayer', 'GMZ-REAL22')");
    await odb.run("INSERT INTO tournaments (game_id, name, format, mode) VALUES ('codm', 'Real Cup', 'double_elim', '5v5')");
    assert.deepEqual(await migrate(odb), ['006_free_fire.js']);
    const ff = await odb.get("SELECT * FROM games WHERE id='ff'");
    assert.equal(ff.name, 'Free Fire'); assert.equal(ff.short_name, 'FF'); assert.equal(ff.id_label, 'Free Fire UID'); assert.match(ff.id_hint, /avatar/);
    assert.equal(ff.series_mode, '4v4'); assert.equal(ff.series_label, 'Clash Squad'); assert.deepEqual(JSON.parse(ff.formats).sort(), ['br_points', 'double_elim', 'single_elim']);
    assert.deepEqual(JSON.parse(ff.modes).sort(), ['4v4', 'duo', 'solo', 'squad']); assert.deepEqual(JSON.parse(ff.default_points_table), [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
    assert.equal((await odb.get("SELECT series_mode FROM games WHERE id='codm'")).series_mode, '5v5');
    assert.equal((await odb.get("SELECT COUNT(*) c FROM games WHERE id='efootball'")).c, 1, 'eFootball not duplicated');
    assert.deepEqual(await migrate(odb), [], 'second start applies nothing');
    const cols = (await odb.all('PRAGMA table_info(games)')).length, M6 = require('../db/migrations/006_free_fire.js');
    await M6.up(odb); await M6.up(odb); // re-running the migration body is safe
    assert.equal((await odb.all('PRAGMA table_info(games)')).length, cols); assert.equal((await odb.get('SELECT COUNT(*) c FROM games')).c, 5);
    assert.equal((await odb.get("SELECT COUNT(*) c FROM tournaments WHERE name='Real Cup'")).c, 1); assert.equal((await odb.get("SELECT gamz_id FROM players WHERE gamer_tag='RealPlayer'")).gamz_id, 'GMZ-REAL22');
    odb.close();
  });
  await test('Free Fire BR scoring: FF default table (12-9-8-7-6-5-4-3-2-1-0-0) + 1/kill; a tournament table overrides it', async () => {
    const ffT = [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0];
    assert.deepEqual(SC.brPoints(1, 5, ffT, 1), { placement_points: 12, kill_points: 5, total: 17 }); assert.equal(SC.brPoints(11, 2, ffT, 1).total, 2); assert.equal(SC.brPoints(13, 0, ffT, 1).total, 0);
    const ts = await teams(12), t = await mkTournament({ game_id: 'ff', name: 'FF BR', format: 'br_points', mode: 'squad', br_match_count: 2 });
    const pids = await register(t, ts, true); await E.generate(db, t);
    const [m1, m2] = (await matches(t)).filter(m => m.stage === 'br');
    assert.equal(m1.map_name, 'Bermuda'); assert.equal(m2.map_name, 'Purgatory');
    await E.recordBr(db, m1.id, pids.map((id, i) => ({ participant_id: id, placement: i + 1, kills: i === 0 ? 5 : i === 10 ? 2 : 0 })));
    let st = (await E.loadTournament(db, t)).standings.br, by = id => st.find(s => s.participant_id === id);
    assert.equal(by(pids[0]).total, 17); assert.equal(by(pids[1]).total, 9); assert.equal(by(pids[9]).total, 1); assert.equal(by(pids[10]).total, 2); assert.equal(by(pids[11]).total, 0);
    await db.run('UPDATE tournaments SET points_table=? WHERE id=?', JSON.stringify([20, 10]), t);
    st = (await E.loadTournament(db, t)).standings.br; assert.equal(st.find(s => s.participant_id === pids[0]).total, 25, 'custom table used');
  });
  await test('Clash Squad 4v4 best-of-3 double elimination: series rules like CoDM (2-1 ok, 2-2 / 1-0 rejected)', async () => {
    const ts = await teams(4), t = await mkTournament({ game_id: 'ff', name: 'CS', format: 'double_elim', mode: '4v4', best_of: 3 });
    await register(t, ts, true); await E.generate(db, t);
    const m = (await matches(t)).find(x => x.status === 'ready');
    await assert.rejects(E.recordResult(db, m.id, { home_score: 2, away_score: 2 }), /Best of 3/);
    await assert.rejects(E.recordResult(db, m.id, { home_score: 1, away_score: 0 }), /Best of 3/);
    await E.recordResult(db, m.id, { home_score: 2, away_score: 1 });
    await playAll(t, undefined, 3); assert.equal((await db.get('SELECT status FROM tournaments WHERE id=?', t)).status, 'completed');
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
      for (const n of ['SseA', 'SseB']) assert.equal((await req('POST', `/api/tournaments/${t.id}/participants`, { new_name: n, in_game_id: n + '-0001' }, admin)).status, 201);
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
    let ana, anaId, anaGz;
    await test('sign-up assigns a gamz ID and can link a first in-game ID; players add/edit/remove their own IDs', async () => {
      const su = await req('POST', '/api/signup', { username: 'ana', password: 'ana-pass-123', gamer_tag: 'AnaStrike', game_id: 'efootball', in_game_id: '1111-222-333', in_game_name: 'Ana' });
      assert.equal(su.status, 201); ana = su.cookie; anaId = su.body.user.player_id;
      const p = (await req('GET', '/api/players/' + anaId)).body; anaGz = p.player.gamz_id;
      assert.match(anaGz, /^GMZ-[2-9A-HJKMNP-Z]{6}$/); assert.deepEqual(p.game_ids.map(x => [x.game_id, x.in_game_id, x.in_game_name]), [['efootball', '1111-222-333', 'Ana']]);
      assert.equal((await req('PUT', '/api/me/game-ids/codm', { in_game_id: '6700000000000001', in_game_name: 'Ana_CM' }, ana)).status, 200);
      assert.equal((await req('PUT', '/api/me/game-ids/codm', { in_game_id: '6700000000000002' }, ana)).body.in_game_id, '6700000000000002');
      assert.equal((await req('DELETE', '/api/me/game-ids/codm', null, ana)).body.game_ids.length, 1);
      assert.equal((await req('PUT', '/api/me/game-ids/codm', { in_game_id: 'x' })).status, 401, 'login required');
      assert.equal((await req('PUT', '/api/players/' + anaId + '/game-ids/dls', { in_game_id: 'DLS-ANA' }, ana)).status, 403, 'players cannot edit others via staff route');
      const dup = await req('POST', '/api/signup', { username: 'ana2', password: 'ana-pass-123', gamer_tag: 'AnaClone', game_id: 'efootball', in_game_id: '1111-222-333' });
      assert.equal(dup.status, 400); assert.match(dup.body.error, /eFootball User ID is already linked/);
      assert.equal((await req('GET', '/api/players')).body.find(x => x.gamer_tag === 'AnaClone'), undefined, 'nothing created on a rejected sign-up');
    });
    await test('registration gate: a linked ID for the game is required (409); organizers can override with a warning', async () => {
      const t = (await req('POST', '/api/tournaments', { game_id: 'dls', name: 'Gate Cup', format: 'single_elim', mode: '1v1' }, admin)).body;
      const r1 = await req('POST', `/api/tournaments/${t.id}/participants`, { player_id: anaId }, admin);
      assert.equal(r1.status, 409); assert.equal(r1.body.code, 'missing_game_id'); assert.match(r1.body.error, /Dream League Soccer Player ID/);
      const r2 = await req('POST', `/api/tournaments/${t.id}/participants`, { player_id: anaId, override_id_check: true }, admin);
      assert.equal(r2.status, 201); assert.match(r2.body.warning, /without a Dream League Soccer Player ID/);
      // quick-add without an ID is refused and creates nothing; with an ID it creates + links
      assert.equal((await req('POST', `/api/tournaments/${t.id}/participants`, { new_name: 'NoIdNewbie' }, admin)).status, 409);
      assert.equal((await req('GET', '/api/players')).body.some(x => x.gamer_tag === 'NoIdNewbie'), false);
      const q = await req('POST', `/api/tournaments/${t.id}/participants`, { new_name: 'QuickDls', in_game_id: 'DLS-QUICK-1', in_game_name: 'Quick FC' }, admin);
      assert.equal(q.status, 201); assert.equal(q.body.warning, undefined);
      assert.equal((await req('POST', `/api/tournaments/${t.id}/participants`, { new_name: 'Thief', in_game_id: 'dls-quick-1' }, admin)).status, 400, 'in-game ID already taken');
      const d = (await req('GET', '/api/tournaments/' + t.id)).body, qp = d.participants.find(p => p.name === 'QuickDls');
      assert.equal(qp.in_game_id, 'DLS-QUICK-1'); assert.equal(qp.in_game_name, 'Quick FC'); assert.match(qp.gamz_id, /^GMZ-/);
      // a player who links their ID can register without override
      const t2 = (await req('POST', '/api/tournaments', { game_id: 'efootball', name: 'Gate 2', format: 'single_elim', mode: '1v1' }, admin)).body;
      const ok = await req('POST', `/api/tournaments/${t2.id}/participants`, { player_id: anaId }, admin); assert.equal(ok.status, 201); assert.equal(ok.body.warning, undefined);
    });
    await test('team registration needs every member linked (organizers can set IDs for them)', async () => {
      const mk = async n => (await req('POST', '/api/players', { gamer_tag: n }, admin)).body;
      const a = await mk('TeamA1'), b = await mk('TeamA2'); assert.match(a.gamz_id, /^GMZ-/);
      await req('PUT', `/api/players/${a.id}/game-ids/codm`, { in_game_id: '6711111111111111' }, admin);
      const team = (await req('POST', '/api/teams', { name: 'Gate Squad', game_id: 'codm', members: [a.id, b.id] }, admin)).body;
      const t = (await req('POST', '/api/tournaments', { game_id: 'codm', name: 'Gate 5v5', format: 'single_elim', mode: '5v5' }, admin)).body;
      const r1 = await req('POST', `/api/tournaments/${t.id}/participants`, { team_id: team.id }, admin); assert.equal(r1.status, 409); assert.deepEqual(r1.body.missing, ['TeamA2']);
      assert.equal((await req('PUT', `/api/players/${b.id}/game-ids/codm`, { in_game_id: '6722222222222222', in_game_name: 'A2_CM' }, admin)).status, 200);
      assert.equal((await req('POST', `/api/tournaments/${t.id}/participants`, { team_id: team.id }, admin)).status, 201);
      const tm = (await req('GET', '/api/teams/' + team.id)).body.members; assert.deepEqual(tm.map(m => m.in_game_id).sort(), ['6711111111111111', '6722222222222222']);
      const ent = (await req('GET', '/api/tournaments/' + t.id)).body.participants[0]; assert.equal(ent.members.length, 2); assert.ok(ent.members.every(m => m.in_game_id && m.gamz_id));
    });
    await test('search finds players by gamz ID (any spelling), in-game ID, in-game name and gamer tag', async () => {
      const ids = r => r.body.players.map(p => p.id);
      for (const q of [anaGz, anaGz.toLowerCase(), anaGz.replace('-', ''), anaGz.slice(4)]) { const r = await req('GET', '/api/search?q=' + encodeURIComponent(q)); assert.equal(r.body.players[0].id, anaId, q); assert.equal(r.body.players[0].matched, 'gamz ID'); }
      const byIg = await req('GET', '/api/search?q=1111-222-333'); assert.deepEqual(ids(byIg), [anaId]); assert.equal(byIg.body.players[0].matched, 'eFootball User ID');
      assert.ok(ids(await req('GET', '/api/search?q=Quick%20FC')).length === 1);
      assert.ok(ids(await req('GET', '/api/search?q=anastr')).includes(anaId));
      assert.ok(byIg.body.players[0].game_ids.some(x => x.in_game_id === '1111-222-333'));
      assert.deepEqual((await req('GET', '/api/search?q=a')).body, { players: [], teams: [] });
      assert.ok((await req('GET', '/api/search?q=Gate%20Squad')).body.teams.length === 1);
    });
    await test('Free Fire over HTTP: listed in /api/games, mode/format validation, default points snapshot, FF UID, leaderboard tab, search', async () => {
      const g = (await req('GET', '/api/games')).body.games, ff = g.find(x => x.id === 'ff');
      assert.ok(ff); assert.equal(ff.id_label, 'Free Fire UID'); assert.equal(g.filter(x => x.id === 'efootball').length, 1); assert.equal(g.length, 5);
      const mk = b => req('POST', '/api/tournaments', { game_id: 'ff', name: 'FF test', ...b }, admin);
      assert.equal((await mk({ format: 'br_points', mode: '4v4' })).status, 400, 'BR cannot be 4v4');
      assert.equal((await mk({ format: 'single_elim', mode: 'squad' })).status, 400, 'Clash Squad brackets are 4v4');
      assert.match((await mk({ format: 'double_elim', mode: 'squad' })).body.error, /Clash Squad matches are 4v4/);
      assert.equal((await mk({ format: 'league', mode: '4v4' })).status, 400, 'no league for FF');
      assert.equal((await mk({ format: 'double_elim', mode: '4v4', best_of: 4 })).status, 400, 'best of must be odd');
      const cs = await mk({ format: 'double_elim', mode: '4v4', best_of: 3 }); assert.equal(cs.status, 201); assert.equal(cs.body.series_label, 'Clash Squad');
      const br = await mk({ format: 'br_points', mode: 'squad' }); assert.equal(br.status, 201); assert.deepEqual(JSON.parse(br.body.points_table), [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
      const pb = await req('POST', '/api/tournaments', { game_id: 'pubgm', name: 'PUBG default', format: 'br_points', mode: 'squad' }, admin); assert.equal(pb.body.points_table, null, 'PUBG keeps the PMCO default');
      assert.equal((await req('POST', '/api/tournaments', { game_id: 'codm', name: 'x', format: 'br_points', mode: '5v5' }, admin)).status, 400, 'CoDM rule still enforced');
      assert.equal((await req('PUT', '/api/me/game-ids/ff', { in_game_id: '1234567890', in_game_name: 'Ana.ff' }, ana)).status, 200);
      const s = await req('GET', '/api/search?q=1234567890'); assert.equal(s.body.players[0].id, anaId); assert.equal(s.body.players[0].matched, 'Free Fire UID');
      assert.equal((await req('GET', '/api/leaderboard?game=ff')).status, 200);
      const r = await req('POST', `/api/tournaments/${br.body.id}/participants`, { player_id: anaId }, admin); assert.equal(r.status, 400, 'squad BR takes teams, not players');
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
