const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

router.get('/', verifyToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const [notifications] = await db.query(
      `SELECT n.id, n.user_id, n.actor_id, n.type, n.ref_id, n.ref_type, n.is_read, n.created_at,
              u.username AS actor_username, u.display_name AS actor_display_name, u.avatar_url AS actor_avatar_url,
        p.caption AS post_caption, p.media_url AS post_media_url,
        egr.id AS request_id, egr.group_id AS request_group_id, egr.status AS request_status,
        eg.event_id AS request_event_id, eg.event_title AS request_event_title,
        eg.name AS request_group_name, eg.community_id AS request_community_id
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.ref_id AND n.ref_type = 'post'
      LEFT JOIN event_group_requests egr ON egr.id = n.ref_id AND n.ref_type = 'event_group_request'
      LEFT JOIN event_groups eg ON eg.id = egr.group_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC
       LIMIT ?`,
      [req.user.id, limit]
    );

    const [[counts]] = await db.query(
      `SELECT COUNT(*) AS unread_count
       FROM notifications
       WHERE user_id = ? AND is_read = 0`,
      [req.user.id]
    );

    res.json({
      notifications: notifications.map(shapeNotification),
      unread_count: Number(counts?.unread_count ?? 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/read-all', verifyToken, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

function shapeNotification(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    actor_id: row.actor_id,
    type: row.type,
    ref_id: row.ref_id,
    ref_type: row.ref_type,
    is_read: Boolean(row.is_read),
    created_at: row.created_at,
    actor: row.actor_id
      ? {
          id: row.actor_id,
          username: row.actor_username,
          display_name: row.actor_display_name,
          avatar_url: row.actor_avatar_url,
        }
      : null,
    post: row.ref_type === 'post'
      ? {
          id: row.ref_id,
          caption: row.post_caption,
          media_url: row.post_media_url,
        }
      : null,
    event_group_request: row.ref_type === 'event_group_request' && row.request_id
      ? {
          id: Number(row.request_id),
          group_id: Number(row.request_group_id),
          status: row.request_status,
          event_id: row.request_event_id,
          event_title: row.request_event_title,
          group_name: row.request_group_name,
          community_id: row.request_community_id ? Number(row.request_community_id) : null,
        }
      : null,
  };
}

module.exports = router;