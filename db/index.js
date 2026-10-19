// Data layer (@libsql/client).
// SAFETY: this app ONLY reads GAMZ_DATABASE_URL / GAMZ_DATABASE_TOKEN. It never looks at any other
// database env var, so it cannot accidentally connect to another app's database.
// With GAMZ_DATABASE_URL unset it uses the local file db/gamz.db.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const LOCAL_FILE = process.env.GAMZ_LOCAL_DB_FILE || path.join(__dirname, 'gamz.db');
const DB_URL = process.env.GAMZ_DATABASE_URL || 'file:' + LOCAL_FILE;
const IS_REMOTE = !DB_URL.startsWith('file:');

const plain = rs => rs.rows.map(r => { const o = {}; rs.columns.forEach((c, i) => { const v = r[i]; o[c] = typeof v === 'bigint' ? Number(v) : v; }); return o; });

function open() {
  const client = createClient({ url: DB_URL, authToken: IS_REMOTE ? (process.env.GAMZ_DATABASE_TOKEN || undefined) : undefined });
  const exec = (sql, args = []) => client.execute({ sql, args });
  return {
    client, url: DB_URL, remote: IS_REMOTE,
    all: async (sql, ...args) => plain(await exec(sql, args)),
    get: async (sql, ...args) => plain(await exec(sql, args))[0],
    run: async (sql, ...args) => { const r = await exec(sql, args); return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) }; },
    batch: stmts => client.batch(stmts.map(([sql, args = []]) => ({ sql, args })), 'write'),
    close: () => client.close(),
  };
}

async function migrate(db) {
  if (!db.remote) await db.run('PRAGMA foreign_keys = ON');
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const dir = path.join(__dirname, 'migrations');
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map(r => r.name));
  const applied = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const stmts = fs.readFileSync(path.join(dir, f), 'utf8').split(/;\s*(?:--[^\n]*)?\n/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    await db.batch([...stmts.map(s => [s]), ['INSERT INTO schema_migrations(name) VALUES (?)', [f]]]);
    applied.push(f);
  }
  return applied;
}
// Masked description for logs / System page (never prints tokens).
const describe = () => IS_REMOTE ? 'turso:' + DB_URL.replace(/^libsql:\/\//, '').replace(/\?.*/, '').replace(/^([^.]{0,4})[^.]*/, '$1***') : 'local-file:' + path.relative(process.cwd(), LOCAL_FILE);
module.exports = { open, migrate, DB_URL, IS_REMOTE, LOCAL_FILE, describe };
