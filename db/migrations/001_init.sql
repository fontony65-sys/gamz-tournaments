-- gamz tournaments: core schema (SQLite / libSQL).
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,                       -- slug: efootball, dls, pubgm, codm
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('football','battle_royale','team_shooter')),
  accent TEXT NOT NULL,                      -- UI accent colour (hex)
  formats TEXT NOT NULL,                     -- JSON array of allowed tournament formats
  modes TEXT NOT NULL,                       -- JSON array of allowed modes
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamer_tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
  real_name TEXT,
  country TEXT DEFAULT 'CM',
  bio TEXT,
  avatar_hue INTEGER NOT NULL DEFAULT 260,
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,               -- scrypt$salt$hash
  role TEXT NOT NULL CHECK (role IN ('admin','organizer','player')),
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256 of the cookie token; raw tokens are never stored
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tag TEXT,
  game_id TEXT REFERENCES games(id),
  is_example INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('captain','member','sub')),
  PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('single_elim','double_elim','league','league_knockout','br_points')),
  mode TEXT NOT NULL,                        -- 1v1, solo, duo, squad, 5v5
  status TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('draft','registration','live','completed')),
  best_of INTEGER NOT NULL DEFAULT 1,        -- series length for team_shooter brackets
  br_match_count INTEGER NOT NULL DEFAULT 6, -- number of BR matches/maps
  points_table TEXT,                         -- JSON array: placement points for 1st, 2nd, ...
  kill_points REAL NOT NULL DEFAULT 1,
  group_count INTEGER NOT NULL DEFAULT 1,    -- league / league_knockout groups
  advance_per_group INTEGER NOT NULL DEFAULT 2,
  starts_at TEXT,
  description TEXT,
  prize TEXT,
  is_example INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tournaments_game ON tournaments(game_id);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id),
  team_id INTEGER REFERENCES teams(id),
  seed INTEGER,
  group_label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((player_id IS NULL) <> (team_id IS NULL)),
  UNIQUE (tournament_id, player_id),
  UNIQUE (tournament_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_t ON participants(tournament_id);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('league','winners','losers','grand_final','grand_final_reset','br')),
  round INTEGER NOT NULL,
  position INTEGER NOT NULL,                 -- order within the round (bracket position)
  group_label TEXT,
  label TEXT,
  home_id INTEGER REFERENCES participants(id),
  away_id INTEGER REFERENCES participants(id),
  next_match_id INTEGER REFERENCES matches(id),         -- winner goes here
  next_slot TEXT CHECK (next_slot IN ('home','away')),
  loser_next_match_id INTEGER REFERENCES matches(id),   -- loser goes here (double elimination)
  loser_next_slot TEXT CHECK (loser_next_slot IN ('home','away')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','completed','bye','void')),
  winner_id INTEGER REFERENCES participants(id),
  loser_id INTEGER REFERENCES participants(id),
  best_of INTEGER NOT NULL DEFAULT 1,
  map_name TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_matches_t ON matches(tournament_id, stage, round, position);

CREATE TABLE IF NOT EXISTS match_results (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  home_score INTEGER NOT NULL,               -- goals (football) or maps won (series)
  away_score INTEGER NOT NULL,
  home_pens INTEGER,                         -- penalty shoot-out (football knockout draws)
  away_pens INTEGER,
  detail TEXT,                               -- optional JSON / notes, e.g. per-map scores
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS br_match_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  placement INTEGER NOT NULL CHECK (placement >= 1),
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (match_id, participant_id),
  UNIQUE (match_id, placement)
);
