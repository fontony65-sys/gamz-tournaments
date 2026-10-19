// Pure scoring helpers (no DB). Shared by the server, the seed script and the tests.

// Standard PMCO/PMPL-style placement table (1st..16th). Configurable per tournament via tournaments.points_table.
const DEFAULT_POINTS_TABLE = [15, 12, 10, 8, 6, 4, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0];
const DEFAULT_KILL_POINTS = 1;

function pointsTable(t) {
  if (t && t.points_table) { try { const a = JSON.parse(t.points_table); if (Array.isArray(a) && a.every(n => typeof n === 'number' && n >= 0)) return a; } catch {} }
  return DEFAULT_POINTS_TABLE;
}
function brPoints(placement, kills, table = DEFAULT_POINTS_TABLE, killPts = DEFAULT_KILL_POINTS) {
  const place = table[placement - 1] || 0, kp = (kills || 0) * killPts;
  return { placement_points: place, kill_points: kp, total: place + kp };
}

// Battle-royale standings across matches. rows: [{participant_id, match_id, placement, kills}]
// Tie-breakers: total points > chicken dinners (WWCD) > placement points > kills > best last-match placement.
function brStandings(participants, rows, t, matchOrder = []) {
  const table = pointsTable(t), kp = t && t.kill_points != null ? t.kill_points : DEFAULT_KILL_POINTS;
  const by = new Map(participants.map(p => [p.id, { participant_id: p.id, name: p.name, played: 0, wwcd: 0, placement_points: 0, kills: 0, kill_points: 0, total: 0, per_match: {} }]));
  for (const r of rows) {
    const s = by.get(r.participant_id); if (!s) continue;
    const pts = brPoints(r.placement, r.kills, table, kp);
    s.played++; s.kills += r.kills; s.placement_points += pts.placement_points; s.kill_points += pts.kill_points; s.total += pts.total;
    if (r.placement === 1) s.wwcd++;
    s.per_match[r.match_id] = { placement: r.placement, kills: r.kills, points: pts.total };
  }
  const last = s => { for (let i = matchOrder.length - 1; i >= 0; i--) { const m = s.per_match[matchOrder[i]]; if (m) return m.placement; } return 999; };
  const list = [...by.values()].sort((a, b) => b.total - a.total || b.wwcd - a.wwcd || b.placement_points - a.placement_points || b.kills - a.kills || last(a) - last(b) || a.name.localeCompare(b.name));
  list.forEach((s, i) => { s.rank = i + 1; });
  return list;
}

// Football league table: win 3, draw 1, loss 0. Tie-breakers: points > goal difference > goals for > wins > name.
function leagueTable(participants, matches) {
  const by = new Map(participants.map(p => [p.id, { participant_id: p.id, name: p.name, group_label: p.group_label, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, form: [] }]));
  for (const m of matches) {
    if (m.status !== 'completed' || !m.result) continue;
    const h = by.get(m.home_id), a = by.get(m.away_id); if (!h || !a) continue;
    const hs = m.result.home_score, as = m.result.away_score;
    h.P++; a.P++; h.GF += hs; h.GA += as; a.GF += as; a.GA += hs;
    if (hs > as) { h.W++; a.L++; h.Pts += 3; h.form.push('W'); a.form.push('L'); }
    else if (hs < as) { a.W++; h.L++; a.Pts += 3; a.form.push('W'); h.form.push('L'); }
    else { h.D++; a.D++; h.Pts++; a.Pts++; h.form.push('D'); a.form.push('D'); }
  }
  const list = [...by.values()]; list.forEach(s => { s.GD = s.GF - s.GA; s.form = s.form.slice(-5); });
  list.sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || b.W - a.W || a.name.localeCompare(b.name));
  return list;
}

// Overall gamz placement points for a final tournament rank.
function placementPoints(rank) {
  if (!rank) return 0;
  if (rank === 1) return 100; if (rank === 2) return 70; if (rank === 3) return 50; if (rank === 4) return 40;
  if (rank <= 8) return 25; if (rank <= 16) return 15; return 10;
}

module.exports = { DEFAULT_POINTS_TABLE, DEFAULT_KILL_POINTS, pointsTable, brPoints, brStandings, leagueTable, placementPoints };
