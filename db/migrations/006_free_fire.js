// Adds Free Fire (Garena Free Fire / Free Fire MAX) and moves the remaining per-game rules into the games table.
// Written in JS so every step is guarded and the whole migration can be re-run safely (SQLite has no
// "ADD COLUMN IF NOT EXISTS"): columns are only added when missing, the game row is INSERT OR IGNORE,
// and backfills only touch NULLs (they never overwrite values changed later).
//
// New games columns:
//   series_mode          mode used by bracket (best-of series) formats; battle-royale formats may not use it (CoDM 5v5, FF 4v4)
//   series_label         what the bracket mode is called in the game (CoDM "Multiplayer", FF "Clash Squad")
//   default_points_table JSON placement-points table used when a BR tournament doesn't set its own
//   br_maps              JSON list of map names used to label BR matches
const COLUMNS = { series_mode: 'TEXT', series_label: 'TEXT', default_points_table: 'TEXT', br_maps: 'TEXT' };

// Free Fire esports-style placement points (12-squad lobby): 1st 12, 2nd 9, 3rd 8 ... 10th 1, 11th-12th 0; + 1 point per kill.
const FF_POINTS = [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0];

async function up(db) {
  const have = new Set((await db.all('PRAGMA table_info(games)')).map(c => c.name));
  for (const [col, type] of Object.entries(COLUMNS)) if (!have.has(col)) await db.run(`ALTER TABLE games ADD COLUMN ${col} ${type}`);

  await db.run(`INSERT OR IGNORE INTO games (id, name, short_name, family, accent, formats, modes, sort_order, id_label, id_hint,
      series_mode, series_label, default_points_table, br_maps)
    VALUES ('ff', 'Free Fire', 'FF', 'team_shooter', '#60a5fa', '["br_points","double_elim","single_elim"]', '["squad","duo","solo","4v4"]', 5,
      'Free Fire UID', 'In Free Fire (or Free Fire MAX, same account) tap your profile avatar at the top left: the UID is the number shown under your name.',
      '4v4', 'Clash Squad', ?, '["Bermuda","Purgatory","Kalahari","Alpine","NeXTerra","Bermuda"]')`, JSON.stringify(FF_POINTS));

  // Existing games: describe their rules as data too (only where still unset).
  await db.run(`UPDATE games SET series_mode='5v5' WHERE id='codm' AND series_mode IS NULL`);
  await db.run(`UPDATE games SET series_label='Multiplayer' WHERE id='codm' AND series_label IS NULL`);
  await db.run(`UPDATE games SET br_maps='["Erangel","Miramar","Sanhok","Vikendi","Erangel","Miramar","Livik","Rondo"]' WHERE id='pubgm' AND br_maps IS NULL`);
  await db.run(`UPDATE games SET br_maps='["Isolated","Blackout","Alcatraz","Isolated","Blackout","Alcatraz"]' WHERE id='codm' AND br_maps IS NULL`);
}
module.exports = { up, FF_POINTS };
