# gamz database schema

SQLite / libSQL (Turso in production, a local file `db/gamz.db` in development). Migrations are plain SQL files in
`db/migrations/`, applied in name order on every start (`schema_migrations` records which ran). Run them by hand with `npm run migrate`.

| Migration | What it does |
|---|---|
| `001_init.sql` | All tables and indexes below |
| `002_games.sql` | Reference rows for the four games (eFootball, DLS, PUBG Mobile, CoD Mobile) |
| `003_user_prefs.sql` | `users.theme` (dark/light preference synced to the account) |

## ER diagram

```mermaid
erDiagram
  games ||--o{ tournaments : "hosts"
  games ||--o{ teams : "main game"
  players ||--o{ team_members : "is in"
  teams ||--o{ team_members : "has"
  players ||--o| users : "claimed by"
  users ||--o{ sessions : "logged in as"
  users ||--o{ tournaments : "created"
  tournaments ||--o{ participants : "registers"
  players ||--o{ participants : "enters (1v1 / solo)"
  teams ||--o{ participants : "enters (duo / squad / 5v5)"
  tournaments ||--o{ matches : "contains"
  participants ||--o{ matches : "home / away / winner / loser"
  matches ||--o| matches : "next_match_id (winner goes to)"
  matches ||--o| matches : "loser_next_match_id (loser drops to)"
  matches ||--o| match_results : "score"
  matches ||--o{ br_match_results : "placements"
  participants ||--o{ br_match_results : "placement + kills"

  games {
    text id PK "efootball | dls | pubgm | codm"
    text name
    text family "football | battle_royale | team_shooter"
    text accent
    text formats "JSON"
    text modes "JSON"
  }
  players {
    int id PK
    text gamer_tag UK
    text real_name
    text country
    text bio
    int avatar_hue
    int is_example
  }
  teams {
    int id PK
    text name UK
    text tag
    text game_id FK
    int is_example
  }
  team_members {
    int team_id PK,FK
    int player_id PK,FK
    text role "captain | member | sub"
  }
  users {
    int id PK
    text username UK
    text password_hash "scrypt"
    text role "admin | organizer | player"
    int player_id FK
    text theme
  }
  sessions {
    text token_hash PK "sha256"
    int user_id FK
    int expires_at
  }
  tournaments {
    int id PK
    text game_id FK
    text name
    text format
    text mode
    text status
    int best_of
    int br_match_count
    text points_table "JSON"
    real kill_points
    int group_count
    int advance_per_group
    text starts_at
    int is_example
  }
  participants {
    int id PK
    int tournament_id FK
    int player_id FK
    int team_id FK
    int seed
    text group_label
  }
  matches {
    int id PK
    int tournament_id FK
    text stage
    int round
    int position
    text group_label
    int home_id FK
    int away_id FK
    int next_match_id FK
    text next_slot
    int loser_next_match_id FK
    text loser_next_slot
    text status
    int winner_id FK
    int loser_id FK
    int best_of
    text map_name
  }
  match_results {
    int match_id PK,FK
    int home_score
    int away_score
    int home_pens
    int away_pens
    text detail
    int entered_by FK
  }
  br_match_results {
    int id PK
    int match_id FK
    int participant_id FK
    int placement
    int kills
    int entered_by FK
  }
```

## Tables

**games** — the games gamz hosts (reference data, not example data). `family` decides the rules: `football` (goals, draws, penalties),
`battle_royale` (placement + kill points), `team_shooter` (best-of-N series). `formats` / `modes` list what an organizer may pick.

**players** — one row per gamer (gamer tag is unique, case-insensitive). Can exist without an account; a player who signs up with the same
gamer tag claims the row. `is_example = 1` marks seed/demo rows.

**teams**, **team_members** — squads, duos and 5v5 rosters. Team results on the overall leaderboard are credited to every current member.

**users** — logins. Exactly one `admin` (username `ADMIN_USER`, password from `ADMIN_PASSWORD`, re-synced on every start); `organizer`
accounts are created by the admin; `player` accounts come from public sign-up (`ALLOW_SIGNUP`). Passwords are hashed with scrypt + salt.

**sessions** — login sessions stored in the database (so they survive restarts). Only a SHA-256 hash of the cookie token is stored. 7-day expiry.

**tournaments** — one event. `format`: `single_elim`, `double_elim`, `league`, `league_knockout`, `br_points`. `status`: `draft` (hidden) →
`registration` → `live` (set automatically when the bracket is generated) → `completed` (set automatically when every match is decided).
`best_of` = series length (CoDM), `br_match_count` / `points_table` / `kill_points` = battle-royale settings, `group_count` /
`advance_per_group` = league groups.

**participants** — who is entered in a tournament: either a player (1v1 / solo) or a team (duo / squad / 5v5), never both (CHECK).
`seed` = seeding order used for the bracket (1 = strongest). `group_label` = league group.

**matches** — every bracket slot / fixture / BR lobby. `stage`: `winners`, `losers`, `grand_final`, `grand_final_reset`, `league`, `br`.
`round` + `position` place it in the bracket. `next_match_id` + `next_slot` say where the winner goes; `loser_next_match_id` +
`loser_next_slot` say where the loser drops (double elimination). `status`: `pending` (waiting for earlier results), `ready`, `completed`,
`bye` (one side can never arrive → the other auto-advances), `void` (both sides empty, or the unused grand-final reset).

**match_results** — head-to-head score for a match: goals (football) or maps won (series), optional penalty shoot-out, optional per-map notes.

**br_match_results** — one row per team/player per battle-royale match: placement (unique per match) and kills. Points are computed, not stored,
so changing a tournament's points table recalculates everything.

**schema_migrations** — names of applied migration files.

## Computed (not stored)

Standings, league tables, final ranks and both leaderboards are recomputed from `match_results` / `br_match_results` (see README,
"How the leaderboard is calculated"). The leaderboard is cached in memory and invalidated on every write.
