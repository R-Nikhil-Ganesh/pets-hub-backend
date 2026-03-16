const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');

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

    const [[existing]] = await db.query(
      'SELECT id FROM post_reactions WHERE post_id = ? AND user_id = ? LIMIT 1',
      [postId, userId]
    );
    if (existing) {
      await db.query('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
      res.json({ reacted: false });
    } else {
      await db.query(
        'INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)',
        [postId, userId, emoji]
      );
      await awardPoints(userId, 1, 'reacted_to_post');
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
    const [result] = await db.query(
      'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)',
      [req.params.id, req.user.id, content.trim()]
    );
    await awardPoints(req.user.id, 3, 'commented');
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
