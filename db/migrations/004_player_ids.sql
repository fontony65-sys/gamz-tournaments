-- Unique, immutable gamz player IDs + per-game in-game IDs.
ALTER TABLE players ADD COLUMN gamz_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_gamz_id ON players(gamz_id);
-- Once set, a gamz ID can never change.
CREATE TRIGGER IF NOT EXISTS trg_players_gamz_id_immutable BEFORE UPDATE OF gamz_id ON players WHEN OLD.gamz_id IS NOT NULL AND NEW.gamz_id IS NOT OLD.gamz_id BEGIN SELECT RAISE(ABORT, 'gamz_id is immutable'); END;

CREATE TABLE IF NOT EXISTS player_game_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id),
  in_game_id TEXT NOT NULL COLLATE NOCASE,   -- e.g. PUBG Mobile Character ID
  in_game_name TEXT,                         -- name shown inside the game
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, in_game_id),
  UNIQUE (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_pgi_player ON player_game_ids(player_id);

ALTER TABLE games ADD COLUMN id_label TEXT;
ALTER TABLE games ADD COLUMN id_hint TEXT;
UPDATE games SET id_label='eFootball User ID', id_hint='In eFootball open your profile / User Information and copy the User ID.' WHERE id='efootball';
UPDATE games SET id_label='Dream League Soccer Player ID', id_hint='In DLS open Settings / Profile and copy your Player ID.' WHERE id='dls';
UPDATE games SET id_label='PUBG Mobile Character ID', id_hint='In PUBG Mobile tap your avatar: the Character ID is the number under your name.' WHERE id='pubgm';
UPDATE games SET id_label='CoD Mobile UID', id_hint='In CoD Mobile open your profile: the UID is shown under your name.' WHERE id='codm';
