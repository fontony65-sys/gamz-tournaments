// Gives every existing player a unique gamz ID (collision-checked). Safe to re-run.
const { backfillGamzIds } = require('../../lib/ids');
module.exports.up = db => backfillGamzIds(db);
