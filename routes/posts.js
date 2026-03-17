const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');
const { emitToUser } = require('../socket');

// GET /api/posts/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS reaction_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id AND user_id = ?) AS user_reacted
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.id = ? AND p.deleted_at IS NULL`,
      [req.user.id, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: shapePost(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// GET /api/posts/:id/comments
router.get('/:id/comments', verifyToken, async (req, res) => {
  try {
    const [comments] = await db.query(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC LIMIT 50`,
      [req.params.id]
    );
    res.json({ comments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST /api/posts — create post
router.post('/', verifyToken, upload.single('media'), async (req, res) => {
  try {
    const { caption, pet_id, location_name } = req.body;
    let media_url = '';
    let media_type = 'image';
    if (req.file) {
      media_type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
      const resourceType = media_type === 'video' ? 'video' : 'image';
      media_url = await uploadStream(req.file.buffer, 'pawprint/posts', resourceType);
    }
    const [result] = await db.query(
      `INSERT INTO posts (user_id, pet_id, caption, media_url, media_type, location_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, pet_id || null, caption || '', media_url, media_type, location_name || '']
    );
    await awardPoints(req.user.id, 10, 'created_post');
    const [rows] = await db.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              0 AS reaction_count, 0 AS comment_count, 0 AS user_reacted
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ post: shapePost(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// POST /api/posts/:id/react — toggle reaction (🐾 default)
router.post('/:id/react', verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    const emoji = req.body.emoji || '🐾';
    const [[postOwner]] = await db.query(
      'SELECT user_id FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [postId]
    );

    if (!postOwner) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const [[existing]] = await db.query(
      'SELECT id FROM post_reactions WHERE post_id = ? AND user_id = ? LIMIT 1',
      [postId, userId]
    );
    if (existing) {
      await db.query('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
      const deletedNotificationId = await deleteNotification(postOwner.user_id, userId, 'like', postId, 'post');
      if (deletedNotificationId) {
        emitToUser(postOwner.user_id, 'notification:remove', { id: deletedNotificationId });
      }
      res.json({ reacted: false });
    } else {
      await db.query(
        'INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)',
        [postId, userId, emoji]
      );
      await awardPoints(userId, 1, 'reacted_to_post');
      const notification = await createNotification(postOwner.user_id, userId, 'like', postId, 'post');
      if (notification) {
        emitToUser(postOwner.user_id, 'notification:new', { notification });
      }
      res.json({ reacted: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to react' });
  }
});

// POST /api/posts/:id/comments
router.post('/:id/comments', verifyToken, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  try {
    const [[postOwner]] = await db.query(
      'SELECT user_id FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [req.params.id]
    );

    if (!postOwner) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const [result] = await db.query(
      'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, content.trim()]
    );
    await awardPoints(req.user.id, 3, 'commented');
    const notification = await createNotification(postOwner.user_id, req.user.id, 'comment', req.params.id, 'post');
    if (notification) {
      emitToUser(postOwner.user_id, 'notification:new', { notification });
    }
    const [[comment]] = await db.query(
      `SELECT c.*, u.username, u.display_name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ comment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// DELETE /api/posts/:id
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const [result] = await db.query(
      'UPDATE posts SET deleted_at = NOW() WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(403).json({ error: 'Not authorized or not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

async function awardPoints(userId, amount, action) {
  await db.query(
    `INSERT INTO user_points (user_id, total_points) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE total_points = total_points + ?`,
    [userId, amount, amount]
  );
  await db.query(
    'INSERT INTO point_transactions (user_id, amount, action) VALUES (?, ?, ?)',
    [userId, amount, action]
  );
}

async function createNotification(userId, actorId, type, refId, refType) {
  if (!userId || !actorId || Number(userId) === Number(actorId)) return;

  const [result] = await db.query(
    `INSERT INTO notifications (user_id, actor_id, type, ref_id, ref_type)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, actorId, type, refId, refType]
  );

  const [[notification]] = await db.query(
    `SELECT n.id, n.user_id, n.actor_id, n.type, n.ref_id, n.ref_type, n.is_read, n.created_at,
            u.username AS actor_username, u.display_name AS actor_display_name, u.avatar_url AS actor_avatar_url,
            p.caption AS post_caption, p.media_url AS post_media_url
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     LEFT JOIN posts p ON p.id = n.ref_id AND n.ref_type = 'post'
     WHERE n.id = ?
     LIMIT 1`,
    [result.insertId]
  );

  return notification ? shapeNotification(notification) : null;
}

async function deleteNotification(userId, actorId, type, refId, refType) {
  const [[existing]] = await db.query(
    `SELECT id FROM notifications
     WHERE user_id = ? AND actor_id = ? AND type = ? AND ref_id = ? AND ref_type = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, actorId, type, refId, refType]
  );

  if (!existing) return null;

  await db.query('DELETE FROM notifications WHERE id = ?', [existing.id]);
  return existing.id;
}

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
  };
}

function shapePost(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    pet: {
      name: row.pet_name,
      breed: row.pet_breed,
      age: row.pet_age,
      photo_url: row.pet_photo_url,
    },
    caption: row.caption,
    media_url: row.media_url,
    media_type: row.media_type,
    location_name: row.location_name,
    reaction_count: Number(row.reaction_count),
    comment_count: Number(row.comment_count),
    user_reacted: Number(row.user_reacted) > 0,
    score: row.score || 0,
    created_at: row.created_at,
  };
}

module.exports = router;
