// Adds EA SPORTS FC Mobile — a football game with the same rules as eFootball / DLS
// (1v1 knockout with penalties on a draw, league, league + knockout). Re-runnable: INSERT OR IGNORE only.
async function up(db) {
  await db.run(`INSERT OR IGNORE INTO games (id, name, short_name, family, accent, formats, modes, sort_order, id_label, id_hint)
    VALUES ('fcm', 'FC Mobile', 'FCM', 'football', '#a78bfa', '["single_elim","league","league_knockout"]', '["1v1"]', 6,
      'FC Mobile Player ID', 'In EA SPORTS FC Mobile open your Profile (tap your avatar) or Settings: the Player ID is shown there. Tap it to copy.')`);
}
module.exports = { up };
