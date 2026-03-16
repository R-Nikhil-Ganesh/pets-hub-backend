const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// GET /api/points/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      'SELECT COALESCE(total_points, 0) AS total FROM user_points WHERE user_id = ?',
      [req.user.id]
    );
    res.json({ points: row?.total ?? 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch points' });
  }
});

// GET /api/points/transactions
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ transactions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET /api/points/rewards
router.get('/rewards', verifyToken, async (req, res) => {
  try {
    const [rewards] = await db.query(
      'SELECT * FROM rewards WHERE is_active = 1 ORDER BY points_cost ASC'
    );
    res.json({ rewards });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rewards' });
  }
});

// POST /api/points/rewards/:id/redeem
router.post('/rewards/:id/redeem', verifyToken, async (req, res) => {
  const rewardId = req.params.id;
  try {
    const [[reward]] = await db.query('SELECT * FROM rewards WHERE id = ? AND is_active = 1', [rewardId]);
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const [[pts]] = await db.query(
      'SELECT COALESCE(total_points, 0) AS total FROM user_points WHERE user_id = ?',
      [req.user.id]
    );
    const currentPoints = pts?.total ?? 0;
    if (currentPoints < reward.points_cost)
      return res.status(400).json({ error: 'Insufficient points' });

    // Deduct points
    await db.query(
      'UPDATE user_points SET total_points = total_points - ? WHERE user_id = ?',
      [reward.points_cost, req.user.id]
    );
    await db.query(
      'INSERT INTO point_transactions (user_id, amount, action) VALUES (?, ?, ?)',
      [req.user.id, -reward.points_cost, `redeemed_reward_${rewardId}`]
    );

    res.json({ ok: true, reward });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Redemption failed' });
  }
});

module.exports = router;
