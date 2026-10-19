# gamz — tournaments, live brackets & leaderboards

A mobile-first web app for the **gamz** gaming community. It hosts and tracks tournaments for **eFootball**, **Dream League Soccer (DLS)**,
**PUBG Mobile** and **Call of Duty: Mobile**, with live brackets, results, per-game and overall leaderboards, player/team profiles,
a random-pairing tool, player accounts and an organizer/admin area. It works great on iPhone and can be added to the home screen.

Built on the same stack as the loan dashboard: **Node 20 + Express + @libsql/client**, data in **Turso** (free hosted libSQL) with a local
file fallback, hosted on the **Render free plan** from GitHub.

---

## What it does

**Public (no login):** home page, tournament list (filter by game/status), tournament page with a live bracket / group tables /
battle-royale standings, match results, leaderboards (overall + per game), player and team profiles, random pairing tool.
Everything updates **live** (Server-Sent Events) — when an organizer enters a result, every open phone updates within a second, no refresh.

**Organizers & admin:** create tournaments, register players/teams (or quick-add new ones), set seeding, generate brackets (seeded or
random draw), enter results, correct/clear results, draw the knockout after a group stage, reset a bracket.
The admin also manages organizer accounts and has a **System** page (database mode, migrations, table counts, live viewers,
remove example data).

**Players:** can sign up (gamer tag + username + password) to claim their profile, edit their bio and keep their theme on every device.

### Game formats

| Game | Formats | Scoring |
|---|---|---|
| **eFootball** / **DLS** | 1v1 single elimination (with byes for any number of players) · league · league + knockout (groups → top N to a bracket) | Score = goals. League: win 3, draw 1, loss 0, tie-break goal difference then goals scored. Knockout draw → penalty shoot-out decides the winner. |
| **PUBG Mobile** | Battle-royale points across several matches/maps (solo, duo, squad) | Per match: placement points + kill points. Default PMCO-style table: 1st 15, 2nd 12, 3rd 10, 4th 8, 5th 6, 6th 4, 7th 2, 8th–12th 1, 13th+ 0; 1 point per kill. Both are configurable per tournament. Tie-break: points → chicken dinners → placement points → kills → best last-match placement. |
| **CoD Mobile** | 5v5 best-of-N series (Bo1/3/5/7) in **double elimination** (with grand-final reset) or single elimination · Battle royale (solo/duo/squad) with the same points system as PUBG | Series: maps won, winner needs ⌈N/2⌉. |

Brackets are generated automatically with standard seeding (1 and 2 can only meet in the final) and **byes** for the top seeds when the
number of entrants isn't a power of two. The winner **auto-advances** when a result is saved; in double elimination the loser drops into the
losers bracket. If the winners-bracket champion loses the grand final, a **reset** match is played automatically.

### How the leaderboard is calculated

Recomputed from match results every time a result is entered (never typed in by hand).

**Placement points** for each *completed* tournament: 1st **100** · 2nd **70** · 3rd **50** · 4th **40** · 5th–8th **25** · 9th–16th **15** · others **10**.
(Knockout losers share places: both semi-final losers are 3rd, quarter-final losers 5th, … Double elimination ranks by the round you were knocked out in.)

- **Per-game leaderboard** (players for 1v1/solo, teams for team modes):
  `score = placement points + 3 × match wins + 1 × draws + battle-royale points`.
  Ties: titles → wins → goal difference → kills. Also shows W-D-L, goal difference, maps, kills, chicken dinners and titles.
- **Overall gamz leaderboard** (per player, across all games; team results count for every team member):
  `gamz points = placement points + 2 × match wins + 1 × draws + 2 × chicken dinners`. Ties: titles → wins.

▲/▼ arrows show who moved since the last update.

---

## Run it locally (for whoever maintains the code)

```bash
npm install
npm run seed:reset       # fresh local db/gamz.db with clearly labelled EXAMPLE data (refuses to run on Turso)
npm start                # http://localhost:3000
npm run verify           # automated tests (uses throw-away databases)
npm run screenshots      # iPhone-size screenshots in both themes (needs Chrome + playwright-core)
```

Locally, with no `ADMIN_PASSWORD` set, the app creates a random admin password and saves it in **`.admin-password.local`**
(git-ignored). Log in as `admin` with that password. The example data also includes a player login: `example_player` / `example-player-pass`.

> **Safety:** this app reads **only** `GAMZ_DATABASE_URL` and `GAMZ_DATABASE_TOKEN`. It never reads any other database variable,
> so it can't touch another app's database. With those two unset it always uses the local file `db/gamz.db`.

Example data is flagged in the database and shown with an "Example" badge. Remove it from **System → Remove example data**
or with `node db/seed.js --clear`.

---

## Put it online — step by step on an iPhone (free)

You need three free accounts: **GitHub** (stores the code), **Turso** (stores the data), **Render** (runs the app).
All steps work in Safari on iPhone. Button names on these websites change from time to time — if one doesn't match exactly, pick the closest one.

### Step 1 — Put the code on GitHub

1. In Safari open **github.com** and log in (the same account you used for the loan app).
2. Tap **+** (top right) → **New repository**. Name it `gamz-tournaments`, choose **Private**, and **don't** add a README. Tap **Create repository**.
3. Get the code into it. The easiest way: ask Grok Bot *"push /workspace/gamz-tournaments to my new GitHub repo gamz-tournaments"*.
   (It was deliberately **not** pushed yet.) From a computer you can instead use **Add file → Upload files** and drag in every file and folder
   **except** `node_modules`, `db/gamz.db`, `.env` and `.admin-password.local`.

### Step 2 — Create the database on Turso

1. Open **turso.tech** → **Sign up / Log in** → **Continue with GitHub**. The free plan needs no card.
2. Tap **Create Database** (or **New Database**). Name it `gamz`. Pick the location closest to Cameroon (a Europe region, e.g. Frankfurt or Paris if offered). Tap **Create**.
   ⚠️ Make a **new** database — don't reuse the loan app's database.
3. Open the `gamz` database. Copy the **URL** — it looks like `libsql://gamz-yourname.turso.io`. Paste it into the Notes app for a minute. This is your **GAMZ_DATABASE_URL**.
4. On the same page tap **Create Token** / **Generate Token**: choose **Read & Write** and **no expiration**. Copy the long token into Notes. This is your **GAMZ_DATABASE_TOKEN**. Treat it like a password.

### Step 3 — Create the web service on Render

1. Open **dashboard.render.com** → log in with **GitHub**.
2. Tap **New +** → **Blueprint**. Pick the `gamz-tournaments` repository (if it's not listed, tap **Configure account** and give Render access to it).
   Render reads the included `render.yaml` and sets up a **free** web service called `gamz-tournaments`.
3. Render asks for the secret values. Fill in:
   - **GAMZ_DATABASE_URL** → the `libsql://…` URL from Turso
   - **GAMZ_DATABASE_TOKEN** → the Turso token
   - **ADMIN_PASSWORD** → a strong password you'll remember (at least 8 characters)

   (`NODE_ENV=production`, `ADMIN_USER=admin` and `ALLOW_SIGNUP=true` are already filled in. `SESSION_SECRET` is **not** needed.)
4. Tap **Apply** / **Deploy**. Wait until it says **Live** (2–5 minutes). Your address is shown at the top, like `https://gamz-tournaments.onrender.com`.

   *Alternative without Blueprint:* **New +** → **Web Service** → pick the repo → Runtime **Node**, Build command `npm install`, Start command `npm start`,
   Instance type **Free**, then add the variables above under **Environment** (plus `NODE_ENV` = `production`).

### Step 4 — First login

1. Open your Render address in Safari. (The live database starts **empty** — no example data online.)
2. Tap the person icon (top right) → log in with username **admin** and your **ADMIN_PASSWORD**.
3. You land on the **Organizer desk**: tap **New** to create your first tournament, register players/teams, then **Generate bracket**.
4. Optional: add organizer accounts for your helpers at the bottom of the Organizer desk.
5. Put it on your home screen: Safari **Share** button → **Add to Home Screen** → **Add**. It opens full-screen like an app.

### Good to know

- **First open can be slow (about 1 minute).** The free Render plan sleeps after 15 minutes without visitors and wakes on the next visit. Your data is safe in Turso.
- **Turso free-tier pause:** on the free plan Turso puts a database to sleep when it's idle and **archives it after 10 days with no activity**.
  If the site suddenly shows errors after a quiet period, log in at turso.tech, open the `gamz` database and tap **Wake up / Unarchive**
  (or with the Turso CLI: `turso group unarchive default`). Opening the site at least once a week keeps it awake.
- **Forgot the admin password?** Change `ADMIN_PASSWORD` in Render → your service → **Environment** → Save. Render restarts the app and the new password works.
- **Too many wrong passwords** (10 in 15 minutes) blocks logins from that phone for 15 minutes.
- **Close sign-ups:** set `ALLOW_SIGNUP` to `false` in Render → Environment.
- **Never** put your token or passwords in a GitHub file — only in Render's Environment settings.
- Updating the app later: push the changed files to GitHub; Render redeploys automatically.

---

## Project structure

```
server.js                 Express app: API, auth, sessions, SSE, static files
lib/bracket.js            Pure bracket builders: seeding, byes, single/double elimination, round robin
lib/engine.js             Tournament engine: generate, auto-advance (settle), results, BR results, standings, final ranks
lib/scoring.js            Points tables, BR standings, league table, placement points
lib/leaderboard.js        Per-game + overall leaderboards (recomputed from results, cached until the next write)
db/index.js               libSQL client (GAMZ_DATABASE_URL / GAMZ_DATABASE_TOKEN or local file) + migration runner
db/migrations/*.sql       Schema migrations
db/seed.js                EXAMPLE data (local only) and example-data removal
public/                   index.html, app.js (single-page app), app.css (dark + light themes), manifest, icons, fonts
scripts/verify.js         Automated tests
scripts/screenshot.js     iPhone screenshots (dark + light) + in-browser live-update check
scripts/make-icons.js     Renders the PWA / home-screen icons
docs/SCHEMA.md            ER diagram and table descriptions
render.yaml, .env.example Deployment config
```

## Design

Chill, aesthetic "aura" look: near-black backgrounds with soft purple and blue glows, glass cards and calm transitions in **dark mode**,
and a matching **light mode** (lavender-tinted off-white, white glass cards, dark indigo text). The sun/moon button in the header switches
themes for everyone (also on the Me/System pages). The choice is saved on the device and on the player's account; the first visit follows the
phone's setting. Per-game accents are subtle shades of purple/blue (eFootball indigo, DLS sky-blue, PUBG violet, CoDM periwinkle).
Text colours meet WCAG AA contrast in both themes. Fonts: Inter + Space Grotesk (bundled, OFL licence).

## API (short)

Public: `GET /api/health`, `/api/games`, `/api/tournaments`, `/api/tournaments/:id`, `/api/leaderboard?game=`, `/api/players/:id`,
`/api/teams/:id`, `/api/overview`, `/api/stream` (SSE). Auth: `POST /api/login`, `/api/logout`, `/api/signup`, `PUT /api/me`.
Organizer: `POST /api/tournaments`, `/api/tournaments/:id/participants`, `/generate`, `/knockout`, `/reset`, `POST /api/matches/:id/result`,
`/br-result`, `DELETE /api/matches/:id/result`, players/teams. Admin: `/api/users`, `/api/system`.
