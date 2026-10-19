// Ensure users.username is unique case-insensitively even on DBs that somehow
// lacked the column UNIQUE from 001_init. Idempotent: IF NOT EXISTS is a no-op
// when the column UNIQUE (or this index) already exists. SQLite allows a unique
// index on an already-unique column.
async function up(db) {
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');
}
module.exports = { up };
