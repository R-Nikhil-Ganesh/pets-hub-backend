const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// GET /api/hot-takes?page=1
router.get('/', verifyToken, async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  try {
    const [rows] = await db.query(
      `SELECT ht.*, u.username, u.display_name, u.avatar_url,
              (SELECT COUNT(*) FROM hot_take_upvotes WHERE hot_take_id = ht.id) AS upvotes,
              (SELECT COUNT(*) FROM hot_take_upvotes WHERE hot_take_id = ht.id AND user_id = ?) AS user_upvoted,
              0 AS comment_count
       FROM hot_takes ht JOIN users u ON u.id = ht.user_id
       WHERE ht.deleted_at IS NULL
       ORDER BY upvotes DESC, ht.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );
    res.json({
      hot_takes: rows.map((r) => ({ ...r, upvotes: Number(r.upvotes), user_upvoted: Number(r.user_upvoted) > 0 })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hot takes' });
  }
});

// POST /api/hot-takes
router.post('/', verifyToken, async (req, res) => {
  const { content, flair } = req.body;
  const validFlairs = ['hot_take', 'unpopular', 'meme', 'debate', 'confession'];
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  const useFlair = validFlairs.includes(flair) ? flair : 'hot_take';
  try {
    const [result] = await db.query(
      'INSERT INTO hot_takes (user_id, content, flair) VALUES (?, ?, ?)',
      [req.user.id, content.trim(), useFlair]
    );
    await awardPoints(req.user.id, 5, 'created_hot_take');
    const [[row]] = await db.query('SELECT * FROM hot_takes WHERE id = ?', [result.insertId]);
    res.status(201).json({ hot_take: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create hot take' });
  }
});

// POST /api/hot-takes/:id/upvote
router.post('/:id/upvote', verifyToken, async (req, res) => {
  try {
    const [[existing]] = await db.query(
      'SELECT id FROM hot_take_upvotes WHERE hot_take_id = ? AND user_id = ? LIMIT 1',
      [req.params.id, req.user.id]
    );
    if (existing) {
      await db.query('DELETE FROM hot_take_upvotes WHERE hot_take_id = ? AND user_id = ?', [
        req.params.id,
        req.user.id,
      ]);
      res.json({ upvoted: false });
    } else {
      await db.query('INSERT INTO hot_take_upvotes (hot_take_id, user_id) VALUES (?, ?)', [
        req.params.id,
        req.user.id,
      ]);
      res.json({ upvoted: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upvote' });
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

module.exports = router;
