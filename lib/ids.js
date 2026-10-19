// gamz player IDs (GMZ-XXXXXX) and per-game in-game IDs.
const crypto = require('crypto');
const err = (msg, status = 400, code) => Object.assign(new Error(msg), { status, code });

// Unambiguous alphabet: no 0/O, 1/I/L. 31 symbols ^ 6 = ~887 million IDs.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GAMZ_ID_RE = /^GMZ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const makeGamzId = (rng = n => crypto.randomInt(n)) => 'GMZ-' + Array.from({ length: 6 }, () => ALPHABET[rng(ALPHABET.length)]).join('');

// "gmz 7k3q9p", "GMZ7K3Q9P", "7k3q9p" -> "GMZ-7K3Q9P" (or null if it can't be a gamz ID)
function normalizeGamzId(q) {
  let s = String(q || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('GMZ')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1'); // map look-alikes, then reject them below
  return s.length === 6 && [...s].every(c => ALPHABET.includes(c)) ? 'GMZ-' + s : null;
}

// Collision-checked: tries a fresh ID until one is free (the UNIQUE index is the final guard).
async function uniqueGamzId(db, rng) {
  for (let i = 0; i < 25; i++) {
    const id = makeGamzId(rng);
    if (!(await db.get('SELECT 1 FROM players WHERE gamz_id=?', id))) return id;
  }
  throw err('Could not generate a unique gamz ID', 500);
}

async function createPlayer(db, f = {}, rng) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const gid = await uniqueGamzId(db, rng);
    try {
      const r = await db.run('INSERT INTO players (gamz_id, gamer_tag, real_name, country, bio, avatar_hue, is_example) VALUES (?,?,?,?,?,?,?)',
        gid, f.gamer_tag, f.real_name || null, f.country || 'CM', f.bio || null, f.avatar_hue ?? (220 + crypto.randomInt(80)), f.is_example ? 1 : 0);
      return { id: r.lastInsertRowid, gamz_id: gid };
    } catch (e) { if (!/UNIQUE/i.test(e.message) || !/gamz_id/i.test(e.message)) throw e; } // race on the same ID: retry
  }
  throw err('Could not generate a unique gamz ID', 500);
}

async function backfillGamzIds(db) {
  const rows = await db.all('SELECT id FROM players WHERE gamz_id IS NULL');
  for (const r of rows) await db.run('UPDATE players SET gamz_id=? WHERE id=? AND gamz_id IS NULL', await uniqueGamzId(db), r.id);
  return rows.length;
}

// In-game IDs: letters, digits and - _ . # space, 3-40 chars. Names 1-32 chars (optional).
const IGID_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.#-]{1,38}[\p{L}\p{N}]$/u;
async function setGameId(db, playerId, gameId, b = {}) {
  const g = await db.get('SELECT * FROM games WHERE id=?', gameId); if (!g) throw err('Unknown game', 404);
  const in_game_id = String(b.in_game_id || '').trim().replace(/\s+/g, ' '), in_game_name = String(b.in_game_name || '').trim().slice(0, 32) || null;
  if (!IGID_RE.test(in_game_id)) throw err(`${g.id_label}: 3–40 letters/numbers (- _ . # allowed)`);
  const clash = await db.get('SELECT p.gamer_tag FROM player_game_ids x JOIN players p ON p.id=x.player_id WHERE x.game_id=? AND x.in_game_id=? AND x.player_id<>?', gameId, in_game_id, playerId);
  if (clash) throw err(`That ${g.id_label} is already linked to another gamz player`);
  await db.run(`INSERT INTO player_game_ids (player_id, game_id, in_game_id, in_game_name) VALUES (?,?,?,?)
    ON CONFLICT(player_id, game_id) DO UPDATE SET in_game_id=excluded.in_game_id, in_game_name=excluded.in_game_name, updated_at=datetime('now')`, playerId, gameId, in_game_id, in_game_name);
  return db.get('SELECT * FROM player_game_ids WHERE player_id=? AND game_id=?', playerId, gameId);
}
const removeGameId = (db, playerId, gameId) => db.run('DELETE FROM player_game_ids WHERE player_id=? AND game_id=?', playerId, gameId);
const gameIdsOf = (db, playerId) => db.all(`SELECT x.game_id, x.in_game_id, x.in_game_name, x.created_at, x.updated_at, g.name AS game_name, g.short_name AS game_short, g.id_label
  FROM player_game_ids x JOIN games g ON g.id=x.game_id WHERE x.player_id=? ORDER BY g.sort_order`, playerId);

module.exports = { ALPHABET, GAMZ_ID_RE, makeGamzId, normalizeGamzId, uniqueGamzId, createPlayer, backfillGamzIds, setGameId, removeGameId, gameIdsOf };
