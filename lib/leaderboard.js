// Leaderboards, recomputed from results (never stored). See README "How the leaderboard is calculated".
//
// Per-game score (players for 1v1/solo games, teams for team modes):
//   score = placement points (completed tournaments) + 3 x match wins + 1 x draws + battle-royale points
// Overall gamz score (per PLAYER, across all games; team results are credited to every team member):
//   gamz points = placement points + 2 x match wins + 1 x draws + 2 x chicken dinners (BR 1st place)
// Placement points per completed tournament: 1st 100, 2nd 70, 3rd 50, 4th 40, 5-8 25, 9-16 15, 17+ 10.
const { loadTournament } = require('./engine');
const { placementPoints } = require('./scoring');

let cache = null, dirty = true, prevRanks = new Map(), version = 0;
const invalidate = () => { dirty = true; };

async function compute(db) {
  const games = await db.all('SELECT * FROM games ORDER BY sort_order');
  const ts = await db.all(`SELECT id FROM tournaments WHERE status IN ('live','completed') ORDER BY id`);
  const members = await db.all('SELECT tm.team_id, tm.player_id FROM team_members tm');
  const players = new Map((await db.all('SELECT id, gamer_tag, avatar_hue, is_example FROM players')).map(p => [p.id, p]));
  const membersOf = new Map(); for (const m of members) { if (!membersOf.has(m.team_id)) membersOf.set(m.team_id, []); membersOf.get(m.team_id).push(m.player_id); }
  const per = Object.fromEntries(games.map(g => [g.id, new Map()]));
  const overall = new Map();
  const row = (gid, p) => {
    const key = p.player_id ? 'p' + p.player_id : 't' + p.team_id, map = per[gid];
    if (!map.has(key)) map.set(key, { key, type: p.player_id ? 'player' : 'team', id: p.player_id || p.team_id, name: p.name, team_tag: p.team_tag, avatar_hue: p.avatar_hue,
      tournaments: 0, played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, gd: 0, maps_won: 0, maps_lost: 0, kills: 0, br_points: 0, wwcd: 0, titles: 0, podiums: 0, placement_points: 0, score: 0 });
    return map.get(key);
  };
  const credit = (p, gid, f) => { // apply f to each player behind participant p (overall board)
    const ids = p.player_id ? [p.player_id] : (membersOf.get(p.team_id) || []);
    for (const id of ids) {
      const pl = players.get(id); if (!pl) continue;
      if (!overall.has(id)) overall.set(id, { key: 'p' + id, type: 'player', id, name: pl.gamer_tag, avatar_hue: pl.avatar_hue, points: 0, titles: 0, podiums: 0, wins: 0, kills: 0, tournaments: new Set(), by_game: {} });
      const o = overall.get(id), before = o.points; f(o); o.by_game[gid] = (o.by_game[gid] || 0) + (o.points - before);
    }
  };
  for (const { id } of ts) {
    const d = await loadTournament(db, id), t = d.tournament, gid = t.game_id, byId = new Map(d.participants.map(p => [p.id, p]));
    for (const p of d.participants) { row(gid, p).tournaments++; credit(p, gid, o => o.tournaments.add(t.id)); }
    for (const m of d.matches) {
      if (m.stage === 'br' || m.status !== 'completed' || !m.result) continue;
      const h = byId.get(m.home_id), a = byId.get(m.away_id); if (!h || !a) continue;
      const hr = row(gid, h), ar = row(gid, a), hs = m.result.home_score, as = m.result.away_score;
      hr.played++; ar.played++;
      if (t.family === 'football') { hr.gf += hs; hr.ga += as; ar.gf += as; ar.ga += hs; } else { hr.maps_won += hs; hr.maps_lost += as; ar.maps_won += as; ar.maps_lost += hs; }
      if (m.winner_id) {
        const w = m.winner_id === h.id ? [hr, h] : [ar, a], l = m.winner_id === h.id ? ar : hr;
        w[0].wins++; l.losses++; credit(w[1], gid, o => { o.wins++; o.points += 2; });
      } else { hr.draws++; ar.draws++; credit(h, gid, o => { o.points += 1; }); credit(a, gid, o => { o.points += 1; }); }
    }
    for (const s of d.standings.br) {
      if (!s.played) continue;
      const p = byId.get(s.participant_id), r = row(gid, p);
      r.played += s.played; r.kills += s.kills; r.br_points += s.total; r.wwcd += s.wwcd;
      credit(p, gid, o => { o.points += 2 * s.wwcd; o.kills += s.kills; });
    }
    if (t.status === 'completed') for (const p of d.participants) {
      if (!p.rank) continue;
      const r = row(gid, p), pp = placementPoints(p.rank);
      r.placement_points += pp; if (p.rank === 1) r.titles++; if (p.rank <= 3) r.podiums++;
      credit(p, gid, o => { o.points += pp; if (p.rank === 1) o.titles++; if (p.rank <= 3) o.podiums++; });
    }
  }
  const out = { version: ++version, computed_at: new Date().toISOString(), games: {}, overall: [] };
  const withMoves = (board, list) => list.map((r, i) => { r.rank = i + 1; const k = board + ':' + r.key, pr = prevRanks.get(k); r.move = pr ? pr - r.rank : 0; prevRanks.set(k, r.rank); return r; });
  for (const g of games) {
    const list = [...per[g.id].values()];
    list.forEach(r => { r.gd = r.gf - r.ga; r.score = r.placement_points + 3 * r.wins + r.draws + r.br_points; });
    list.sort((a, b) => b.score - a.score || b.titles - a.titles || b.wins - a.wins || b.gd - a.gd || b.kills - a.kills || a.name.localeCompare(b.name));
    out.games[g.id] = withMoves(g.id, list);
  }
  const ol = [...overall.values()].map(o => ({ ...o, tournaments: o.tournaments.size }));
  ol.sort((a, b) => b.points - a.points || b.titles - a.titles || b.wins - a.wins || a.name.localeCompare(b.name));
  out.overall = withMoves('overall', ol);
  return out;
}

async function get(db) {
  if (dirty || !cache) { dirty = false; try { cache = await compute(db); } catch (e) { dirty = true; throw e; } }
  return cache;
}
module.exports = { get, compute, invalidate };
