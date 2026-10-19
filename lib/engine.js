// Tournament engine: bracket generation, auto-advance, results, standings and final ranks (DB-backed).
const { firstRoundSlots, singleElim, doubleElim, roundRobin } = require('./bracket');
const { brStandings, leagueTable } = require('./scoring');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const FINAL = new Set(['completed', 'bye', 'void']);
const STAGE_ORDER = { league: 0, winners: 1, losers: 2, grand_final: 3, grand_final_reset: 4, br: 5 };
const BR_MAPS = { pubgm: ['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Erangel', 'Miramar', 'Livik', 'Rondo'], codm: ['Isolated', 'Blackout', 'Alcatraz', 'Isolated', 'Blackout', 'Alcatraz'] };

async function getT(db, tid) {
  const t = await db.get(`SELECT t.*, g.family, g.name AS game_name, g.short_name AS game_short, g.accent FROM tournaments t JOIN games g ON g.id=t.game_id WHERE t.id=?`, tid);
  if (!t) throw err('Tournament not found', 404);
  return t;
}
const PART_SQL = `SELECT pa.*, COALESCE(pl.gamer_tag, tm.name) AS name, tm.tag AS team_tag, COALESCE(pl.avatar_hue, 250) AS avatar_hue,
    pl.gamz_id, gi.in_game_id, gi.in_game_name
  FROM participants pa LEFT JOIN players pl ON pl.id=pa.player_id LEFT JOIN teams tm ON tm.id=pa.team_id
  LEFT JOIN tournaments tt ON tt.id=pa.tournament_id LEFT JOIN player_game_ids gi ON gi.player_id=pa.player_id AND gi.game_id=tt.game_id`;
// Team rosters with each member's gamz ID and in-game ID for this tournament's game.
async function attachMembers(db, tid, parts) {
  const teams = parts.filter(p => p.team_id); if (!teams.length) return;
  const rows = await db.all(`SELECT tm.team_id, tm.role, p.id AS player_id, p.gamer_tag, p.gamz_id, gi.in_game_id, gi.in_game_name
    FROM participants pa JOIN tournaments t ON t.id=pa.tournament_id JOIN team_members tm ON tm.team_id=pa.team_id JOIN players p ON p.id=tm.player_id
    LEFT JOIN player_game_ids gi ON gi.player_id=p.id AND gi.game_id=t.game_id
    WHERE pa.tournament_id=? ORDER BY CASE tm.role WHEN 'captain' THEN 0 ELSE 1 END, p.gamer_tag`, tid);
  for (const p of teams) p.members = rows.filter(r => r.team_id === p.team_id).map(({ team_id, ...r }) => r);
}
const participantsOf = (db, tid) => db.all(PART_SQL + ' WHERE pa.tournament_id=? ORDER BY COALESCE(pa.seed, 9999), pa.id', tid);

async function insertSpecs(db, tid, specs, extra = {}) {
  const ids = {};
  for (const s of specs) {
    const r = await db.run(`INSERT INTO matches (tournament_id,stage,round,position,group_label,label,home_id,away_id,best_of,map_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      tid, s.stage, s.round, s.position, s.group_label || extra.group_label || null, s.label, s.home ?? null, s.away ?? null, s.best_of || 1, s.map_name || null, s.home != null && s.away != null ? 'ready' : 'pending');
    ids[s.key] = r.lastInsertRowid;
  }
  const upd = specs.filter(s => s.next || s.lnext).map(s => ['UPDATE matches SET next_match_id=?, next_slot=?, loser_next_match_id=?, loser_next_slot=? WHERE id=?',
    [s.next ? ids[s.next[0]] : null, s.next ? s.next[1] : null, s.lnext ? ids[s.lnext[0]] : null, s.lnext ? s.lnext[1] : null, ids[s.key]]]);
  if (upd.length) await db.batch(upd);
  return ids;
}

// Generate the bracket / fixtures. opts.pairing: 'seeded' (default), 'random', 'as_listed' (with opts.order = participant ids).
async function generate(db, tid, opts = {}) {
  const t = await getT(db, tid);
  if ((await db.get('SELECT COUNT(*) c FROM matches WHERE tournament_id=?', tid)).c) throw err('Bracket already generated. Reset it first.');
  let parts = await participantsOf(db, tid);
  if (parts.length < 2) throw err('Register at least 2 participants first');
  let ids = parts.map(p => p.id), pairing = opts.pairing || 'seeded';
  if (Array.isArray(opts.order) && opts.order.length) {
    const set = new Set(ids), ord = opts.order.map(Number);
    if (ord.length !== ids.length || !ord.every(i => set.has(i)) || new Set(ord).size !== ord.length) throw err('order must list every participant exactly once');
    ids = ord;
  } else if (pairing === 'random') { ids = shuffle(ids); pairing = 'as_listed'; }
  // Persist the order used as the seed numbers.
  await db.batch(ids.map((id, i) => ['UPDATE participants SET seed=? WHERE id=?', [i + 1, id]]));
  const bo = t.family === 'team_shooter' ? t.best_of : 1, fbo = bo;
  if (t.format === 'single_elim') await insertSpecs(db, tid, singleElim(firstRoundSlots(ids, pairing), { bestOf: bo, finalBestOf: fbo }));
  else if (t.format === 'double_elim') await insertSpecs(db, tid, doubleElim(firstRoundSlots(ids, pairing), { bestOf: bo, finalBestOf: fbo }));
  else if (t.format === 'league' || t.format === 'league_knockout') {
    const g = Math.max(1, Math.min(t.group_count || 1, Math.floor(ids.length / 2))), groups = Array.from({ length: g }, () => []);
    ids.forEach((id, i) => { const row = Math.floor(i / g), col = i % g; groups[row % 2 ? g - 1 - col : col].push(id); }); // snake draft by seed
    const upd = [];
    for (let gi = 0; gi < g; gi++) {
      const label = g > 1 ? 'Group ' + String.fromCharCode(65 + gi) : null;
      groups[gi].forEach(id => upd.push(['UPDATE participants SET group_label=? WHERE id=?', [label, id]]));
      const specs = [];
      roundRobin(groups[gi]).forEach((pairs, r) => pairs.forEach(([h, a], p) => specs.push({ key: `G${gi}-${r}-${p}`, stage: 'league', round: r + 1, position: p, group_label: label, label: `Matchday ${r + 1}`, home: h, away: a })));
      await insertSpecs(db, tid, specs);
    }
    await db.batch(upd);
  } else if (t.format === 'br_points') {
    const n = Math.max(1, Math.min(t.br_match_count || 6, 20)), maps = BR_MAPS[t.game_id] || BR_MAPS.pubgm, specs = [];
    for (let i = 0; i < n; i++) specs.push({ key: 'B' + i, stage: 'br', round: i + 1, position: 0, label: `Match ${i + 1}`, map_name: maps[i % maps.length] });
    await insertSpecs(db, tid, specs);
    await db.run(`UPDATE matches SET status='ready' WHERE tournament_id=? AND stage='br'`, tid);
  }
  await db.run(`UPDATE tournaments SET status='live', completed_at=NULL WHERE id=?`, tid);
  await settle(db, tid);
  return loadTournament(db, tid);
}

function shuffle(a) { a = [...a]; const c = require('crypto'); for (let i = a.length - 1; i > 0; i--) { const j = c.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// league_knockout: build the knockout bracket from the top N of each group (A1, B1, A2, B2, ... as seeds).
async function generateKnockout(db, tid) {
  const t = await getT(db, tid);
  if (t.format !== 'league_knockout') throw err('Not a league + knockout tournament');
  const ms = await db.all('SELECT * FROM matches WHERE tournament_id=?', tid);
  if (ms.some(m => m.stage === 'winners')) throw err('Knockout stage already generated');
  if (!ms.length || ms.some(m => m.stage === 'league' && m.status !== 'completed')) throw err('Finish all league matches first');
  const d = await loadTournament(db, tid), seeds = [];
  const tables = d.standings.groups, per = Math.max(1, t.advance_per_group || 2);
  for (let pos = 0; pos < per; pos++) for (const g of tables) if (g.table[pos]) seeds.push(g.table[pos].participant_id);
  if (seeds.length < 2) throw err('Not enough qualified participants');
  await insertSpecs(db, tid, singleElim(firstRoundSlots(seeds, 'seeded'), {}));
  await settle(db, tid); await refreshStatus(db, tid);
  return loadTournament(db, tid);
}

async function resetBracket(db, tid) {
  await getT(db, tid);
  await db.batch([
    ['DELETE FROM match_results WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=?)', [tid]],
    ['DELETE FROM br_match_results WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=?)', [tid]],
    ['UPDATE matches SET next_match_id=NULL, loser_next_match_id=NULL WHERE tournament_id=?', [tid]],
    ['DELETE FROM matches WHERE tournament_id=?', [tid]],
    ['UPDATE participants SET group_label=NULL WHERE tournament_id=?', [tid]],
    [`UPDATE tournaments SET status='registration', completed_at=NULL WHERE id=?`, [tid]],
  ]);
}

// Auto-advance: resolve byes (one live slot whose other side can never be filled) and void matches, until stable.
async function settle(db, tid) {
  for (let guard = 0; guard < 200; guard++) {
    const ms = await db.all('SELECT * FROM matches WHERE tournament_id=?', tid), by = new Map(ms.map(m => [m.id, m]));
    const feeders = new Map(ms.map(m => [m.id, { home: [], away: [] }]));
    for (const m of ms) {
      if (m.next_match_id) feeders.get(m.next_match_id)[m.next_slot].push(m);
      if (m.loser_next_match_id) feeders.get(m.loser_next_match_id)[m.loser_next_slot].push(m);
    }
    let changed = false;
    for (const m of ms) {
      if (FINAL.has(m.status) || m.stage === 'br' || m.stage === 'league' || m.stage === 'grand_final_reset') continue;
      const dead = s => m[s + '_id'] == null && feeders.get(m.id)[s].every(f => FINAL.has(by.get(f.id).status));
      const h = m.home_id != null, a = m.away_id != null;
      if (h && a) { if (m.status !== 'ready') { await db.run(`UPDATE matches SET status='ready' WHERE id=?`, m.id); changed = true; } continue; }
      if ((h && dead('away')) || (a && dead('home'))) {
        const w = h ? m.home_id : m.away_id;
        await db.run(`UPDATE matches SET status='bye', winner_id=?, loser_id=NULL, completed_at=datetime('now') WHERE id=?`, w, m.id);
        if (m.next_match_id) await db.run(`UPDATE matches SET ${m.next_slot}_id=? WHERE id=?`, w, m.next_match_id);
        changed = true; break;
      }
      if (dead('home') && dead('away')) { await db.run(`UPDATE matches SET status='void', completed_at=datetime('now') WHERE id=?`, m.id); changed = true; break; }
    }
    if (!changed) break;
  }
  await refreshStatus(db, tid);
}

async function refreshStatus(db, tid) {
  const t = await db.get('SELECT * FROM tournaments WHERE id=?', tid);
  const ms = await db.all('SELECT stage, status FROM matches WHERE tournament_id=?', tid);
  if (!ms.length) return;
  let done = ms.every(m => FINAL.has(m.status));
  if (t.format === 'league_knockout' && !ms.some(m => m.stage === 'winners')) done = false;
  if (done && t.status !== 'completed') await db.run(`UPDATE tournaments SET status='completed', completed_at=datetime('now') WHERE id=?`, tid);
  if (!done && t.status === 'completed') await db.run(`UPDATE tournaments SET status='live', completed_at=NULL WHERE id=?`, tid);
  if (!done && (t.status === 'registration' || t.status === 'draft')) await db.run(`UPDATE tournaments SET status='live' WHERE id=?`, tid);
}

const intOrNull = v => (v === '' || v == null ? null : Number(v));
const isInt = v => Number.isInteger(v) && v >= 0 && v <= 999;

// Enter (or correct) a head-to-head result. Winner auto-advances; loser drops (double elim).
async function recordResult(db, mid, body = {}, userId = null) {
  const m = await db.get('SELECT * FROM matches WHERE id=?', mid); if (!m) throw err('Match not found', 404);
  const t = await getT(db, m.tournament_id);
  if (m.stage === 'br') throw err('Use the battle-royale result form for this match');
  if (m.home_id == null || m.away_id == null) throw err('Both sides of this match are not decided yet');
  if (m.status === 'bye' || m.status === 'void') throw err('This match is a bye');
  const hs = intOrNull(body.home_score), as = intOrNull(body.away_score);
  if (!isInt(hs) || !isInt(as)) throw err('Scores must be whole numbers (0 or more)');
  let hp = intOrNull(body.home_pens), ap = intOrNull(body.away_pens), winner = null;
  if (t.family === 'football') {
    if (hs !== as) { winner = hs > as ? m.home_id : m.away_id; hp = ap = null; }
    else if (m.stage === 'league') { hp = ap = null; }
    else {
      if (!isInt(hp) || !isInt(ap) || hp === ap) throw err('Draw in a knockout match: enter the penalty shoot-out score (it cannot be level)');
      winner = hp > ap ? m.home_id : m.away_id;
    }
  } else {
    const need = Math.floor((m.best_of || 1) / 2) + 1; hp = ap = null;
    if (Math.max(hs, as) !== need || Math.min(hs, as) >= need) throw err(`Best of ${m.best_of}: the winner must have exactly ${need} map win${need > 1 ? 's' : ''}`);
    winner = hs > as ? m.home_id : m.away_id;
  }
  if (m.status === 'completed') await retract(db, m);
  const loser = winner == null ? null : (winner === m.home_id ? m.away_id : m.home_id);
  const detail = body.detail == null ? null : (typeof body.detail === 'string' ? body.detail.slice(0, 2000) : JSON.stringify(body.detail).slice(0, 2000));
  const stmts = [
    ['DELETE FROM match_results WHERE match_id=?', [mid]],
    ['INSERT INTO match_results (match_id,home_score,away_score,home_pens,away_pens,detail,entered_by) VALUES (?,?,?,?,?,?,?)', [mid, hs, as, hp, ap, detail, userId]],
    [`UPDATE matches SET status='completed', winner_id=?, loser_id=?, completed_at=datetime('now') WHERE id=?`, [winner, loser, mid]],
  ];
  if (winner && m.next_match_id) stmts.push([`UPDATE matches SET ${m.next_slot}_id=? WHERE id=?`, [winner, m.next_match_id]]);
  if (loser && m.loser_next_match_id) stmts.push([`UPDATE matches SET ${m.loser_next_slot}_id=? WHERE id=?`, [loser, m.loser_next_match_id]]);
  if (m.stage === 'grand_final') {
    const r = await db.get(`SELECT id FROM matches WHERE tournament_id=? AND stage='grand_final_reset'`, m.tournament_id);
    if (r) stmts.push(winner === m.home_id
      ? [`UPDATE matches SET status='void', home_id=NULL, away_id=NULL, completed_at=datetime('now') WHERE id=?`, [r.id]]   // winners-bracket champion won: no reset needed
      : [`UPDATE matches SET status='ready', home_id=?, away_id=?, completed_at=NULL WHERE id=?`, [m.home_id, m.away_id, r.id]]); // first loss for WB champion: bracket reset
  }
  await db.batch(stmts);
  await settle(db, m.tournament_id);
  return { tournament_id: m.tournament_id, game_id: t.game_id };
}

// Undo a result: pulls the winner/loser back out of later matches (only if those have no result yet).
async function retract(db, m, dry = true) {
  const plan = [];
  const walk = async mm => {
    if (mm.stage === 'grand_final') {
      const r = await db.get(`SELECT * FROM matches WHERE tournament_id=? AND stage='grand_final_reset'`, mm.tournament_id);
      if (r) { if (r.status === 'completed') throw err('The grand final reset already has a result — clear that first'); plan.push([`UPDATE matches SET status='pending', home_id=NULL, away_id=NULL, winner_id=NULL, loser_id=NULL, completed_at=NULL WHERE id=?`, [r.id]]); }
    }
    for (const [nid, slot, pid] of [[mm.next_match_id, mm.next_slot, mm.winner_id], [mm.loser_next_match_id, mm.loser_next_slot, mm.loser_id]]) {
      if (!nid || !pid) continue;
      const d = await db.get('SELECT * FROM matches WHERE id=?', nid);
      if (d[slot + '_id'] !== pid) continue;
      if (d.status === 'completed') throw err(`"${d.label}" already has a result — clear that result first`);
      if (d.status === 'bye') await walk(d);
      plan.push([`UPDATE matches SET ${slot}_id=NULL, status='pending', winner_id=NULL, loser_id=NULL, completed_at=NULL WHERE id=?`, [d.id]]);
    }
  };
  await walk(m);
  if (plan.length) await db.batch(plan);
}

async function clearResult(db, mid) {
  const m = await db.get('SELECT * FROM matches WHERE id=?', mid); if (!m) throw err('Match not found', 404);
  if (m.stage === 'br') {
    await db.batch([['DELETE FROM br_match_results WHERE match_id=?', [mid]], [`UPDATE matches SET status='ready', completed_at=NULL WHERE id=?`, [mid]]]);
  } else {
    if (m.status !== 'completed') throw err('This match has no result to clear');
    await retract(db, m);
    await db.batch([['DELETE FROM match_results WHERE match_id=?', [mid]], [`UPDATE matches SET status='ready', winner_id=NULL, loser_id=NULL, completed_at=NULL WHERE id=?`, [mid]]]);
  }
  await settle(db, m.tournament_id);
  const t = await getT(db, m.tournament_id);
  return { tournament_id: m.tournament_id, game_id: t.game_id };
}

// Battle-royale result: rows = [{participant_id, placement, kills}] — every participant that played.
async function recordBr(db, mid, rows, userId = null) {
  const m = await db.get('SELECT * FROM matches WHERE id=?', mid); if (!m) throw err('Match not found', 404);
  if (m.stage !== 'br') throw err('Not a battle-royale match');
  const t = await getT(db, m.tournament_id);
  const valid = new Set((await participantsOf(db, m.tournament_id)).map(p => p.id));
  if (!Array.isArray(rows) || !rows.length) throw err('Enter at least one team/player result');
  const seenP = new Set(), seenPl = new Set();
  const clean = rows.map(r => ({ participant_id: Number(r.participant_id), placement: Number(r.placement), kills: Number(r.kills || 0) }));
  for (const r of clean) {
    if (!valid.has(r.participant_id)) throw err('Unknown participant in results');
    if (!Number.isInteger(r.placement) || r.placement < 1 || r.placement > 100) throw err('Placement must be 1 or more');
    if (!isInt(r.kills)) throw err('Kills must be a whole number (0 or more)');
    if (seenP.has(r.participant_id)) throw err('A participant appears twice'); seenP.add(r.participant_id);
    if (seenPl.has(r.placement)) throw err(`Two entries share placement #${r.placement}`); seenPl.add(r.placement);
  }
  await db.batch([
    ['DELETE FROM br_match_results WHERE match_id=?', [mid]],
    ...clean.map(r => ['INSERT INTO br_match_results (match_id,participant_id,placement,kills,entered_by) VALUES (?,?,?,?,?)', [mid, r.participant_id, r.placement, r.kills, userId]]),
    [`UPDATE matches SET status='completed', completed_at=datetime('now') WHERE id=?`, [mid]],
  ]);
  await refreshStatus(db, m.tournament_id);
  return { tournament_id: m.tournament_id, game_id: t.game_id };
}

// Final (or provisional) ranks. Returns Map participant_id -> rank.
function computeRanks(t, parts, matches, standings) {
  const ranks = new Map();
  if (t.format === 'br_points') { standings.br.forEach(s => { if (s.played) ranks.set(s.participant_id, s.rank); }); return ranks; }
  const ko = matches.filter(m => m.stage === 'winners');
  if (t.format === 'league' || (t.format === 'league_knockout' && !ko.length)) {
    if (!matches.length || matches.some(m => m.status !== 'completed')) return ranks;
    leagueOrder(standings.groups).forEach((pid, i) => ranks.set(pid, i + 1)); return ranks;
  }
  if (t.format === 'double_elim') {
    const gf = matches.find(m => m.stage === 'grand_final'), gr = matches.find(m => m.stage === 'grand_final_reset');
    const dec = gr && gr.status === 'completed' ? gr : (gf && gf.status === 'completed' && (!gr || gr.status === 'void') ? gf : null);
    if (dec) { ranks.set(dec.winner_id, 1); ranks.set(dec.loser_id, 2); }
    const lb = matches.filter(m => m.stage === 'losers' && m.status === 'completed'), L = Math.max(0, ...lb.map(m => m.round));
    let next = 3;
    for (let j = L; j >= 1; j--) { const ls = lb.filter(m => m.round === j).map(m => m.loser_id).filter(Boolean); ls.forEach(p => ranks.set(p, next)); next += ls.length; }
    return ranks;
  }
  // single elimination (also the knockout part of league_knockout)
  const R = Math.max(0, ...ko.map(m => m.round));
  for (const m of ko) if (m.status === 'completed' && m.loser_id) ranks.set(m.loser_id, 2 ** (R - m.round) + 1);
  const fin = ko.find(m => m.round === R);
  if (fin && fin.status === 'completed') ranks.set(fin.winner_id, 1);
  if (t.format === 'league_knockout' && fin && fin.status === 'completed') {
    const inKo = new Set(ko.flatMap(m => [m.home_id, m.away_id]).filter(Boolean));
    let next = inKo.size + 1;
    for (const pid of leagueOrder(standings.groups)) if (!inKo.has(pid)) ranks.set(pid, next++);
  }
  return ranks;
}
// Interleave group tables: all 1st places (best first), then all 2nd places, ...
function leagueOrder(groups) {
  const out = [], max = Math.max(0, ...groups.map(g => g.table.length));
  for (let i = 0; i < max; i++) groups.map(g => g.table[i]).filter(Boolean).sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF).forEach(s => out.push(s.participant_id));
  return out;
}

async function loadTournament(db, tid) {
  const t = await getT(db, tid);
  const parts = await participantsOf(db, tid);
  await attachMembers(db, tid, parts);
  const matches = await db.all('SELECT * FROM matches WHERE tournament_id=?', tid);
  const results = new Map((await db.all('SELECT r.* FROM match_results r JOIN matches m ON m.id=r.match_id WHERE m.tournament_id=?', tid)).map(r => [r.match_id, r]));
  const brRows = await db.all('SELECT r.* FROM br_match_results r JOIN matches m ON m.id=r.match_id WHERE m.tournament_id=? ORDER BY r.match_id, r.placement', tid);
  matches.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.group_label || '').localeCompare(b.group_label || '') || a.round - b.round || a.position - b.position);
  for (const m of matches) { m.result = results.get(m.id) || null; if (m.stage === 'br') m.br = brRows.filter(r => r.match_id === m.id); }
  const standings = { groups: [], br: [] };
  if (t.format === 'league' || t.format === 'league_knockout') {
    const labels = [...new Set(parts.map(p => p.group_label))].sort();
    standings.groups = labels.map(l => ({ label: l, table: leagueTable(parts.filter(p => p.group_label === l), matches.filter(m => m.stage === 'league' && m.group_label === l)) }));
  }
  if (t.format === 'br_points') standings.br = brStandings(parts, brRows, t, matches.filter(m => m.stage === 'br').map(m => m.id));
  const ranks = computeRanks(t, parts, matches, standings);
  for (const p of parts) p.rank = ranks.get(p.id) || null;
  return { tournament: t, participants: parts, matches, standings };
}

module.exports = { generate, generateKnockout, resetBracket, settle, recordResult, clearResult, recordBr, loadTournament, participantsOf, getT, computeRanks, PART_SQL, err };
