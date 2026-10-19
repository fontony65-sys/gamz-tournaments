const { open, migrate, describe } = require('./index');
(async () => { const db = open(); const a = await migrate(db);
  console.log(`DB ${describe()}: applied ${a.length ? a.join(', ') : 'nothing (up to date)'}`); db.close(); })()
  .catch(e => { console.error(e); process.exit(1); });
