// EXAMPLE DATA ONLY — for local development and screenshots. Every row created here is flagged is_example=1
// (players, teams, tournaments) and shown with an "Example" badge in the app. Remove it any time from the
// System page or with:  node db/seed.js --clear
// Refuses to run against a remote (Turso) database.
const fs = require('fs');
const crypto = require('crypto');
const { open, migrate, IS_REMOTE, LOCAL_FILE, describe } = require('./index');
const E = require('../lib/engine');
const IDS = require('../lib/ids');

let s = 20261019; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const TAGS = ['KmerViper', 'WouriGhost', 'MboaNova', 'SanagaBlaze', 'KribiWave', 'BueaFrost', 'LimbeLynx', 'NdoleKing', 'EkoStorm', 'BafangAce', 'GarouaHawk', 'DschangOwl',
  'YaoundeRush', 'EdeaShade', 'KumbaRiot', 'BamendaZen', 'MarouaDust', 'BertouaFox', 'NgaoundereSky', 'EbolowaJet', 'MbalmayoMint', 'FoumbanRune', 'LoumKid', 'TikoTide',
  'SoaSniper', 'OmegaMboa', 'LunaKmer', 'PixelLion', 'NeonBaobab', 'ZikoPlays', 'AmaraGG', 'KofiClutch', 'NalaAim', 'JunoFrag', 'TchoupiOP', 'MvogMaster',
  'AkwaPrime', 'BonaberiBolt', 'DeidoDash', 'MakepeMax', 'BastosByte', 'EtoudiEcho', 'NlongkakNinja', 'OdzaOrbit', 'MimbomanMage', 'EkieEdge', 'NkolbissonNox', 'EmanaEmber',
  'SimbockStar', 'MendongMoon', 'BiyemAssi', 'TsingaTitan', 'MessaMist', 'OyomabangOx', 'NsamNomad', 'EssosEcho', 'MvanVolt', 'AhalaArc', 'NgousoNeo', 'EligEssono',
  'KondenguiK', 'MokoloMako', 'NkomoNix', 'OlembeOne'];
const PUBG_TEAMS = ['Mboa Vipers', 'Wouri Wolves', 'Sanaga Saints', 'Kribi Krakens', 'Buea Bears', 'Limbe Lions', 'Dschang Drift', 'Garoua Ghosts', 'Edea Echo', 'Kumba Kings', 'Maroua Mirage', 'Bertoua Blitz'];
const COD_TEAMS = ['Nova Syndicate', 'Baobab Brigade', 'Indigo Order', 'Violet Vanguard', 'Midnight Unit', 'Aura Esports', 'Lunar Legion', 'Haze Collective'];

async function clearExample(db) {
  const ts = await db.all('SELECT id FROM tournaments WHERE is_example=1');
  for (const t of ts) { await E.resetBracket(db, t.id); await db.run('DELETE FROM participants WHERE tournament_id=?', t.id); await db.run('DELETE FROM tournaments WHERE id=?', t.id); }
  await db.run('DELETE FROM player_game_ids WHERE player_id IN (SELECT id FROM players WHERE is_example=1)');
  await db.run('DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE is_example=1) OR player_id IN (SELECT id FROM players WHERE is_example=1)');
  await db.run('DELETE FROM participants WHERE team_id IN (SELECT id FROM teams WHERE is_example=1) OR player_id IN (SELECT id FROM players WHERE is_example=1)');
  await db.run(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='player' AND player_id IN (SELECT id FROM players WHERE is_example=1))`);
  await db.run(`DELETE FROM users WHERE role='player' AND player_id IN (SELECT id FROM players WHERE is_example=1)`);
  await db.run('DELETE FROM teams WHERE is_example=1');
  await db.run('DELETE FROM players WHERE is_example=1');
}

const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10) + 'T18:00';
async function mkT(db, o) {
  const k = Object.keys(o); const r = await db.run(`INSERT INTO tournaments (${k.join(',')},is_example) VALUES (${k.map(() => '?').join(',')},1)`, ...k.map(x => o[x]));
  return r.lastInsertRowid;
}
async function register(db, tid, { players = [], teams = [] }) {
  let seed = 1;
  for (const p of players) await db.run('INSERT INTO participants (tournament_id, player_id, seed) VALUES (?,?,?)', tid, p, seed++);
  for (const t of teams) await db.run('INSERT INTO participants (tournament_id, team_id, seed) VALUES (?,?,?)', tid, t, seed++);
}
// Play head-to-head matches that are ready. limit = max matches; filter by stage/round if given.
async function play(db, tid, { family, limit = Infinity, stage, maxRound, pensEvery = 4, detail = 'Hardpoint · Search & Destroy · Domination' } = {}) {
  let n = 0, guard = 0;
  while (n < limit && guard++ < 500) {
    const m = await db.get(`SELECT * FROM matches WHERE tournament_id=? AND status='ready' AND stage<>'br' ${stage ? 'AND stage=?' : ''} ${maxRound ? 'AND round<=?' : ''} ORDER BY CASE stage WHEN 'league' THEN 0 WHEN 'winners' THEN 1 WHEN 'losers' THEN 2 ELSE 3 END, round, position LIMIT 1`, ...[tid, stage, maxRound].filter(x => x !== undefined));
    if (!m) break;
    let body;
    if (family === 'football') {
      const h = ri(0, 4), a = ri(0, 4);
      body = { home_score: h, away_score: a };
      if (h === a && m.stage !== 'league') { const hp = ri(3, 5); body.home_pens = hp; body.away_pens = hp === 5 ? 4 : hp + (rnd() < 0.5 ? 1 : -1); }
      if (h === a && m.stage !== 'league' && body.home_pens === body.away_pens) body.away_pens++;
    } else {
      const need = Math.floor(m.best_of / 2) + 1, lose = ri(0, need - 1), homeWins = rnd() < (m.stage === 'grand_final' ? 0.35 : 0.55);
      body = { home_score: homeWins ? need : lose, away_score: homeWins ? lose : need, detail };
    }
    await E.recordResult(db, m.id, body); n++;
  }
  return n;
}
async function playBr(db, tid, count) {
  const parts = await E.participantsOf(db, tid);
  const strength = new Map(parts.map((p, i) => [p.id, 1 - i / parts.length / 1.4]));
  const ms = await db.all(`SELECT * FROM matches WHERE tournament_id=? AND stage='br' ORDER BY round LIMIT ?`, tid, count);
  for (const m of ms) {
    const order = parts.map(p => ({ p, r: rnd() * strength.get(p.id) })).sort((a, b) => b.r - a.r);
    await E.recordBr(db, m.id, order.map((o, i) => ({ participant_id: o.p.id, placement: i + 1, kills: Math.max(0, Math.round((parts.length - i) / 1.6 + ri(-2, 3))) })));
  }
}

async function seed({ reset = false } = {}) {
  if (IS_REMOTE) throw new Error('Refusing to seed a remote database. Unset GAMZ_DATABASE_URL — example data is for local use only.');
  if (reset) for (const f of [LOCAL_FILE, LOCAL_FILE + '-wal', LOCAL_FILE + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
  const db = open(); await migrate(db);
  await clearExample(db);
  const P = [];
  const digits = n => Array.from({ length: n }, (_, i) => (i === 0 ? ri(1, 9) : ri(0, 9))).join('');
  const rng = n => Math.floor(rnd() * n); // deterministic example gamz IDs
  for (const tag of TAGS) {
    const p = await IDS.createPlayer(db, { gamer_tag: tag, country: 'CM', bio: 'Example player profile (demo data).', avatar_hue: ri(225, 290), is_example: 1 }, rng);
    P.push(p.id);
    // EXAMPLE in-game IDs (made up) for every game
    await IDS.setGameId(db, p.id, 'efootball', { in_game_id: `${digits(4)}-${digits(3)}-${digits(3)}`, in_game_name: tag });
    await IDS.setGameId(db, p.id, 'dls', { in_game_id: 'DLS' + digits(8), in_game_name: tag + ' FC' });
    await IDS.setGameId(db, p.id, 'pubgm', { in_game_id: '5' + digits(9), in_game_name: 'gmz.' + tag });
    await IDS.setGameId(db, p.id, 'codm', { in_game_id: '67' + digits(14), in_game_name: tag + '_CM' });
  }
  const mkTeam = async (name, game, members) => {
    const id = (await db.run('INSERT INTO teams (name, tag, game_id, is_example) VALUES (?,?,?,1)', name, name.split(' ').map(w => w[0]).join('').toUpperCase(), game)).lastInsertRowid;
    for (let i = 0; i < members.length; i++) await db.run('INSERT INTO team_members (team_id, player_id, role) VALUES (?,?,?)', id, members[i], i === 0 ? 'captain' : 'member');
    return id;
  };
  const pubgTeams = []; for (let i = 0; i < 12; i++) pubgTeams.push(await mkTeam(PUBG_TEAMS[i], 'pubgm', P.slice(16 + i * 4, 20 + i * 4).map((x, j) => P[(16 + i * 4 + j) % P.length])));
  const codTeams = []; for (let i = 0; i < 8; i++) codTeams.push(await mkTeam(COD_TEAMS[i], 'codm', Array.from({ length: 5 }, (_, j) => P[(i * 5 + j + 2) % P.length])));

  // 1) eFootball single elimination, 12 players (4 byes) — LIVE, quarter-finals in progress
  let t = await mkT(db, { game_id: 'efootball', name: 'gamz eFootball Cup #7', format: 'single_elim', mode: '1v1', starts_at: day(-2), prize: '25 000 XAF', description: 'Example tournament — 1v1, single elimination, penalties on a draw.' });
  await register(db, t, { players: P.slice(0, 12) }); await E.generate(db, t); await play(db, t, { family: 'football', limit: 6 });
  // 2) eFootball league + knockout, 8 players, 2 groups — COMPLETED
  t = await mkT(db, { game_id: 'efootball', name: 'gamz League — Season 1', format: 'league_knockout', mode: '1v1', group_count: 2, advance_per_group: 2, starts_at: day(-30), prize: '50 000 XAF', description: 'Example — two groups (W/D/L, goal difference), top 2 to the semi-finals.' });
  await register(db, t, { players: shuffle(P.slice(0, 14)).slice(0, 8) }); await E.generate(db, t); await play(db, t, { family: 'football' }); await E.generateKnockout(db, t); await play(db, t, { family: 'football' });
  // 3) DLS single elimination, 6 players — COMPLETED
  t = await mkT(db, { game_id: 'dls', name: 'DLS Friday Night Cup', format: 'single_elim', mode: '1v1', starts_at: day(-9), prize: '10 000 XAF', description: 'Example — Dream League Soccer knockout with byes.' });
  await register(db, t, { players: shuffle(P.slice(4, 20)).slice(0, 6) }); await E.generate(db, t); await play(db, t, { family: 'football' });
  // 4) PUBG Mobile squads, 12 teams, 6 matches — LIVE (4 played)
  t = await mkT(db, { game_id: 'pubgm', name: 'PUBG M Squad Showdown', format: 'br_points', mode: 'squad', br_match_count: 6, kill_points: 1, starts_at: day(-1), prize: '60 UC per player', description: 'Example — 12 squads, 6 maps, PMCO-style placement points + 1 point per kill.' });
  await register(db, t, { teams: pubgTeams }); await E.generate(db, t); await playBr(db, t, 4);
  // 5) PUBG Mobile solos — COMPLETED
  t = await mkT(db, { game_id: 'pubgm', name: 'PUBG M Solo Sprint', format: 'br_points', mode: 'solo', br_match_count: 3, starts_at: day(-14), description: 'Example — solo lobbies, 3 matches.' });
  await register(db, t, { players: shuffle(P.slice(20, 50)).slice(0, 14) }); await E.generate(db, t); await playBr(db, t, 3);
  // 6) CoDM double elimination, 8 teams, Bo3 — LIVE (grand final next)
  t = await mkT(db, { game_id: 'codm', name: 'CoDM Masters — Double Elim', format: 'double_elim', mode: '5v5', best_of: 3, starts_at: day(-3), prize: '40 000 XAF', description: 'Example — 5v5 best-of-3 series, double elimination with grand-final reset.' });
  await register(db, t, { teams: codTeams }); await E.generate(db, t); await play(db, t, { family: 'team_shooter', limit: 13 });
  // 7) CoDM double elimination, 6 teams (byes), Bo5 — COMPLETED
  t = await mkT(db, { game_id: 'codm', name: 'CoDM Clash Cup', format: 'double_elim', mode: '5v5', best_of: 5, starts_at: day(-20), description: 'Example — 6 teams, byes for the top seeds, best-of-5.' });
  await register(db, t, { teams: shuffle(codTeams).slice(0, 6) }); await E.generate(db, t); await play(db, t, { family: 'team_shooter' });
  // 8) CoDM battle royale duos — REGISTRATION open
  t = await mkT(db, { game_id: 'codm', name: 'CoDM BR Duos Night', format: 'br_points', mode: 'duo', br_match_count: 4, starts_at: day(5), description: 'Example — Call of Duty: Mobile battle royale, same points system as PUBG.' });
  const duo = []; for (let i = 0; i < 6; i++) duo.push(await mkTeam(['Echo Duo', 'Haze Pair', 'Orbit Twins', 'Neon Two', 'Mist Duo', 'Lunar Pair'][i], 'codm', [P[50 + i * 2], P[51 + i * 2]]));
  await register(db, t, { teams: duo });
  // Free Fire (added later — kept at the end so the earlier example data stays identical)
  for (let i = 0; i < P.length; i++) await IDS.setGameId(db, P[i], 'ff', { in_game_id: digits(10), in_game_name: TAGS[i] + '.ff' });
  const FF_SQUADS = ['Bermuda Owls', 'Kalahari Ghosts', 'Purgatory Mist', 'Alpine Nova', 'NeXTerra Five', 'Wouri Flames', 'Sanaga Storm', 'Mount Cameroon', 'Ekom Falls', 'Lobe Tide', 'Waza Lions', 'Dja Echo'];
  const ffTeams = []; for (let i = 0; i < 12; i++) ffTeams.push(await mkTeam(FF_SQUADS[i], 'ff', Array.from({ length: 4 }, (_, j) => P[(i * 4 + j + 9) % P.length])));
  // 9) Free Fire battle royale squads, 12 squads, 6 matches, FF default points table — COMPLETED
  t = await mkT(db, { game_id: 'ff', name: 'Free Fire Bermuda Squads', format: 'br_points', mode: 'squad', br_match_count: 6, kill_points: 1, starts_at: day(-6), prize: '5 000 diamonds', description: 'Example — 12 squads, 6 matches, Free Fire esports-style placement points (12-9-8-7-6-5-4-3-2-1) + 1 point per kill.' });
  await register(db, t, { teams: ffTeams }); await E.generate(db, t); await playBr(db, t, 6);
  // 10) Free Fire Clash Squad 4v4, 6 squads, Bo3 double elimination — LIVE
  t = await mkT(db, { game_id: 'ff', name: 'Clash Squad Showdown', format: 'double_elim', mode: '4v4', best_of: 3, starts_at: day(0), prize: '20 000 XAF', description: 'Example — Free Fire Clash Squad 4v4, best-of-3 series, double elimination.' });
  await register(db, t, { teams: ffTeams.slice(0, 6) }); await E.generate(db, t); await play(db, t, { family: 'team_shooter', limit: 5, detail: 'Clash Squad · Bermuda 4–2 · Kalahari 3–4 · Purgatory 4–1' });
  // Example player account for trying the profile page locally.
  const pw = 'example-player-pass';
  const salt = crypto.randomBytes(16).toString('hex');
  await db.run(`INSERT OR REPLACE INTO users (username,password_hash,role,player_id) VALUES ('example_player',?,'player',?)`, `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`, P[0]);
  const c = await db.get('SELECT (SELECT COUNT(*) FROM players) p, (SELECT COUNT(*) FROM teams) t, (SELECT COUNT(*) FROM tournaments) tt, (SELECT COUNT(*) FROM matches) m');
  db.close();
  return { ...c, example_login: { username: 'example_player', password: pw } };
}

module.exports = { seed, clearExample };
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--clear')) { if (IS_REMOTE) throw new Error('Run --clear from the System page when using Turso.'); const db = open(); await migrate(db); await clearExample(db); db.close(); console.log('Example data removed from', describe()); return; }
    const r = await seed({ reset: process.argv.includes('--reset') });
    console.log(`EXAMPLE data seeded into ${describe()}: ${r.p} players, ${r.t} teams, ${r.tt} tournaments, ${r.m} matches.`);
    console.log(`Example player login: ${r.example_login.username} / ${r.example_login.password}`);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
