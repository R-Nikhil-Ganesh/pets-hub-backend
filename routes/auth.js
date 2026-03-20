const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');

const sign = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// POST /api/auth/register
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('username').matches(/^[a-z0-9_]{3,20}$/),
    body('password').isLength({ min: 8 }),
    body('display_name').trim().isLength({ min: 1, max: 60 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { email, username, password, display_name } = req.body;

    try {
      // Check uniqueness
      const [existing] = await db.query(
        'SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1',
        [email, username]
      );
      if (existing.length > 0)
        return res.status(409).json({ error: 'Email or username already taken' });

      const password_hash = await bcrypt.hash(password, 12);
      const [result] = await db.query(
        `INSERT INTO users (email, username, display_name, password_hash)
         VALUES (?, ?, ?, ?)`,
        [email, username, display_name, password_hash]
      );
      const userId = result.insertId;

      // Award registration points
      await db.query(
        `INSERT INTO user_points (user_id, total_points) VALUES (?, 50)
         ON DUPLICATE KEY UPDATE total_points = total_points + 50`,
        [userId]
      );
      await db.query(
        `INSERT INTO point_transactions (user_id, amount, action)
         VALUES (?, 50, 'registration_bonus')`,
        [userId]
      );

      // Auto-join default communities (flagged is_default)
      const [defaults] = await db.query('SELECT id FROM communities WHERE is_default = 1');
      for (const c of defaults) {
        await db.query(
          'INSERT IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)',
          [c.id, userId]
        );
      }

      const [rows] = await db.query(
        `SELECT u.*, COALESCE(up.total_points, 0) AS points,
          (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count_live,
          (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count_live
         FROM users u
         LEFT JOIN user_points up ON up.user_id = u.id
         WHERE u.id = ?`,
        [userId]
      );
            const user = sanitizeUser(rows[0]);
      const token = sign({ id: userId, username });

      res.status(201).json({ user, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });

    const { email, password } = req.body;

    try {
      const [rows] = await db.query(
        `SELECT u.*, COALESCE(up.total_points, 0) AS points,
          (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS follower_count_live,
          (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following_count_live
         FROM users u
         LEFT JOIN user_points up ON up.user_id = u.id
         WHERE u.email = ? LIMIT 1`,
        [email]
      );
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

      const row = rows[0];
      const valid = await bcrypt.compare(password, row.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

      // Attach pet profiles
      const [pets] = await db.query('SELECT * FROM pet_profiles WHERE user_id = ?', [row.id]);
      const user = { ...sanitizeUser(row), pet_profiles: pets };
      const token = sign({ id: row.id, username: row.username });

      res.json({ user, token });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

function sanitizeUser(row) {
  const {
    password_hash,
    follower_count_live,
    following_count_live,
    ...safe
  } = row;
  if (follower_count_live !== undefined) safe.follower_count = Number(follower_count_live);
  if (following_count_live !== undefined) safe.following_count = Number(following_count_live);
  return safe;
}

module.exports = router;
