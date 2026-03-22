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

  // Run every 15 minutes: delete empty Event Crew communities
  cron.schedule('*/15 * * * *', async () => {
    try {
      const [emptyCrews] = await db.query(
        `SELECT c.id FROM communities c
         WHERE c.name LIKE 'Event Crew:%'
         AND (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) = 0`
      );

      if (emptyCrews && emptyCrews.length > 0) {
        const ids = emptyCrews.map((c) => c.id);
        const placeholders = ids.map(() => '?').join(',');
        const result = await db.query(
          `DELETE FROM communities WHERE id IN (${placeholders})`,
          ids
        );
        if (result[0].affectedRows > 0) {
          console.log(`[cron] Deleted ${result[0].affectedRows} empty Event Crew community(ies)`);
        }
      }
    } catch (err) {
      console.error('[cron] Event Crew cleanup error:', err.message);
    }
  });

  console.log('[cron] Story expiry job scheduled (hourly)');
  console.log('[cron] Event Crew cleanup job scheduled (every 15 minutes)');
}

module.exports = { initCron };
