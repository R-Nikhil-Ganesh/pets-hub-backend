const cron = require('node-cron');
const db = require('../config/db');

function initCron() {
  // Run every hour: soft-delete stories that have passed their expires_at
  cron.schedule('0 * * * *', async () => {
    try {
      const [result] = await db.query(
        `UPDATE stories
         SET deleted_at = NOW()
         WHERE expires_at < NOW() AND deleted_at IS NULL`
      );
      if (result.affectedRows > 0) {
        console.log(`[cron] Expired ${result.affectedRows} story(ies)`);
      }
    } catch (err) {
      console.error('[cron] Story expiry error:', err.message);
    }
  });

  console.log('[cron] Story expiry job scheduled (hourly)');
}

module.exports = { initCron };
