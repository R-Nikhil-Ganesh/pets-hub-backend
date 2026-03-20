const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');

// GET /api/users/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.*, COALESCE(up.total_points, 0) AS points,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count_live,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count_live
       FROM users u
       LEFT JOIN user_points up ON up.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const [pets] = await db.query('SELECT * FROM pet_profiles WHERE user_id = ?', [req.user.id]);
    const { password_hash, follower_count_live, following_count_live, ...user } = rows[0];
    user.follower_count = Number(follower_count_live);
    user.following_count = Number(following_count_live);
    res.json({ user: { ...user, pet_profiles: pets } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/users/me/posts
router.get('/me/posts', verifyToken, async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = 12;
  const offset = (page - 1) * limit;
  try {
    const [posts] = await db.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS reaction_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id AND user_id = ?) AS user_reacted
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.user_id = ? AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, req.user.id, limit, offset]
    );
    res.json({ posts: posts.map(shapePost) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// PUT /api/users/me — update display_name / bio / avatar
router.put('/me', verifyToken, upload.single('avatar'), async (req, res) => {
  try {
    const { display_name, bio } = req.body;
    let avatar_url;
    if (req.file) {
      avatar_url = await uploadStream(req.file.buffer, 'pawprint/avatars');
    }
    const updates = [];
    const vals = [];
    if (display_name) { updates.push('display_name = ?'); vals.push(display_name); }
    if (bio !== undefined) { updates.push('bio = ?'); vals.push(bio); }
    if (avatar_url) { updates.push('avatar_url = ?'); vals.push(avatar_url); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.user.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);

    const [rows] = await db.query(
      `SELECT u.*, COALESCE(up.total_points, 0) AS points,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count_live,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count_live
       FROM users u
       LEFT JOIN user_points up ON up.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    const { password_hash, follower_count_live, following_count_live, ...user } = rows[0];
    user.follower_count = Number(follower_count_live);
    user.following_count = Number(following_count_live);
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// GET /api/users/:id
router.get('/:id', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url,
              u.is_professional, u.professional_type,
              COALESCE(up.total_points, 0) AS points,
              (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count
       FROM users u LEFT JOIN user_points up ON up.user_id = u.id WHERE u.id = ?`,
      [targetId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const [pets] = await db.query('SELECT * FROM pet_profiles WHERE user_id = ?', [targetId]);
    const [[followRow]] = await db.query(
      'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1',
      [req.user.id, targetId]
    );
    res.json({ user: { ...rows[0], pet_profiles: pets }, is_following: !!followRow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// GET /api/users/:id/posts
router.get('/:id/posts', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  const page = Number(req.query.page) || 1;
  const limit = 12;
  const offset = (page - 1) * limit;
  try {
    const [posts] = await db.query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS reaction_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id AND user_id = ?) AS user_reacted
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.user_id = ? AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, targetId, limit, offset]
    );
    res.json({ posts: posts.map(shapePost) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/users/:id/followers
router.get('/:id/followers', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const [[targetUser]] = await db.query(
      'SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1',
      [targetId]
    );
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const [rows] = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              u.is_professional, u.professional_type,
              (SELECT COUNT(*) FROM follows rel
               WHERE rel.follower_id = ? AND rel.following_id = u.id) AS is_following
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, targetId, limit + 1, offset]
    );

    const has_more = rows.length > limit;
    const users = rows.slice(0, limit).map((row) => ({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      is_professional: Boolean(row.is_professional),
      professional_type: row.professional_type,
      is_following: Number(row.is_following) > 0,
    }));

    res.json({
      users,
      page,
      has_more,
      target_user: targetUser,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

// GET /api/users/:id/following
router.get('/:id/following', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const [[targetUser]] = await db.query(
      'SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1',
      [targetId]
    );
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const [rows] = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              u.is_professional, u.professional_type,
              (SELECT COUNT(*) FROM follows rel
               WHERE rel.follower_id = ? AND rel.following_id = u.id) AS is_following
       FROM follows f
       JOIN users u ON u.id = f.following_id
       WHERE f.follower_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, targetId, limit + 1, offset]
    );

    const has_more = rows.length > limit;
    const users = rows.slice(0, limit).map((row) => ({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      is_professional: Boolean(row.is_professional),
      professional_type: row.professional_type,
      is_following: Number(row.is_following) > 0,
    }));

    res.json({
      users,
      page,
      has_more,
      target_user: targetUser,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch following list' });
  }
});

// POST /api/users/:id/follow
router.post('/:id/follow', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
  try {
    const [[targetUser]] = await db.query('SELECT id FROM users WHERE id = ? LIMIT 1', [targetId]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const [insertResult] = await db.query('INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', [
      req.user.id,
      targetId,
    ]);

    if (insertResult.affectedRows > 0) {
      await db.query(
        `UPDATE users
         SET following_count = (SELECT COUNT(*) FROM follows WHERE follower_id = ?)
         WHERE id = ?`,
        [req.user.id, req.user.id]
      );
      await db.query(
        `UPDATE users
         SET follower_count = (SELECT COUNT(*) FROM follows WHERE following_id = ?)
         WHERE id = ?`,
        [targetId, targetId]
      );

      // Points reward for first follow
      await awardPoints(req.user.id, 5, 'followed_someone');
    }

    const [[counts]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
         (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count`,
      [targetId, req.user.id]
    );

    res.json({
      ok: true,
      is_following: true,
      target_follower_count: Number(counts.follower_count),
      actor_following_count: Number(counts.following_count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Follow failed' });
  }
});

// DELETE /api/users/:id/follow
router.delete('/:id/follow', verifyToken, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  try {
    const [deleteResult] = await db.query('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [
      req.user.id,
      targetId,
    ]);

    if (deleteResult.affectedRows > 0) {
      await db.query(
        `UPDATE users
         SET following_count = (SELECT COUNT(*) FROM follows WHERE follower_id = ?)
         WHERE id = ?`,
        [req.user.id, req.user.id]
      );
      await db.query(
        `UPDATE users
         SET follower_count = (SELECT COUNT(*) FROM follows WHERE following_id = ?)
         WHERE id = ?`,
        [targetId, targetId]
      );
    }

    const [[counts]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS follower_count,
         (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count`,
      [targetId, req.user.id]
    );

    res.json({
      ok: true,
      is_following: false,
      target_follower_count: Number(counts.follower_count),
      actor_following_count: Number(counts.following_count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unfollow failed' });
  }
});

// POST /api/users/pets — add pet profile
router.post(
  '/pets',
  verifyToken,
  upload.single('photo'),
  [
    body('name').trim().notEmpty(),
    body('breed').trim().notEmpty(),
    body('age').isInt({ min: 0, max: 50 }),
    body('species').isIn(['dog', 'cat', 'bird', 'rabbit', 'other']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      let photo_url = '';
      if (req.file) {
        photo_url = await uploadStream(req.file.buffer, 'pawprint/pets');
      }
      const { name, breed, age, species } = req.body;
      const [result] = await db.query(
        'INSERT INTO pet_profiles (user_id, name, breed, age, species, photo_url) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, name, breed, Number(age), species, photo_url]
      );
      const [rows] = await db.query('SELECT * FROM pet_profiles WHERE id = ?', [result.insertId]);
      res.status(201).json({ pet: rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to add pet' });
    }
  }
);

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
    score: row.score,
    created_at: row.created_at,
  };
}

module.exports = router;
