const router = require('express').Router();
const db = require('../config/db');
const { client: redis } = require('../config/redis');
const { verifyToken } = require('../middleware/auth');

const TRIVIA_QUEUE_KEY = 'trivia:queue';

// POST /api/games/trivia/queue — join matchmaking queue
router.post('/trivia/queue', verifyToken, async (req, res) => {
  try {
    // Add user to sorted set queue (score = unix timestamp)
    await redis.zAdd(TRIVIA_QUEUE_KEY, { score: Date.now(), value: String(req.user.id) });
    // Check if we have 2+ players queued
    const queued = await redis.zRangeWithScores(TRIVIA_QUEUE_KEY, 0, 1);
    if (queued.length >= 2) {
      const player1Id = Number(queued[0].value);
      const player2Id = Number(queued[1].value);
      await redis.zRem(TRIVIA_QUEUE_KEY, [String(player1Id), String(player2Id)]);

      // Fetch 10 trivia questions
      const [questions] = await db.query(
        'SELECT * FROM trivia_questions ORDER BY RAND() LIMIT 10'
      );

      // Create game session
      const [result] = await db.query(
        'INSERT INTO game_sessions (mode, player1_id, player2_id, status) VALUES (?, ?, ?, ?)',
        ['trivia', player1Id, player2Id, 'active']
      );
      const sessionId = result.insertId;

      // Emit via socket (socket.js handles this via pub/sub)
      await redis.publish(
        'game:start',
        JSON.stringify({ session_id: sessionId, player1_id: player1Id, player2_id: player2Id, questions })
      );
    }
    res.json({ ok: true, status: 'queued' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join queue' });
  }
});

// DELETE /api/games/trivia/queue — leave queue
router.delete('/trivia/queue', verifyToken, async (req, res) => {
  try {
    await redis.zRem(TRIVIA_QUEUE_KEY, String(req.user.id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to leave queue' });
  }
});

// POST /api/games/trivia/:sessionId/end — record result
router.post('/trivia/:sessionId/end', verifyToken, async (req, res) => {
  const { winner_id, my_score } = req.body;
  try {
    await db.query('UPDATE game_sessions SET status = ?, winner_id = ? WHERE id = ?', [
      'finished',
      winner_id || null,
      req.params.sessionId,
    ]);
    const pointsWon = winner_id === req.user.id ? 100 : 20;
    await awardPoints(req.user.id, pointsWon, winner_id === req.user.id ? 'trivia_win' : 'trivia_played');

    // Update leaderboard in Redis sorted set
    await redis.zIncrBy('leaderboard:trivia', pointsWon, String(req.user.id));

    res.json({ ok: true, points_awarded: pointsWon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record result' });
  }
});

// GET /api/games/leaderboard
router.get('/leaderboard', verifyToken, async (req, res) => {
  try {
    const entries = await redis.zRangeWithScores('leaderboard:trivia', 0, 49, { REV: true });
    if (entries.length === 0) return res.json({ leaderboard: [] });

    const userIds = entries.map((e) => Number(e.value));
    const [users] = await db.query(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id IN (?)',
      [userIds]
    );
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const leaderboard = entries.map((e, i) => ({
      rank: i + 1,
      user_id: Number(e.value),
      score: e.score,
      ...userMap[Number(e.value)],
    }));

    res.json({ leaderboard });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
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

// GET /api/games/challenges — daily challenges
router.get('/challenges', verifyToken, async (req, res) => {
  // Static daily challenges seeded from trivia_questions; fully dynamic version optional
  const challenges = [
    { id: 1, title: 'Post a photo of your pet', points: 10, completed_today: false },
    { id: 2, title: 'Comment on 3 posts', points: 15, completed_today: false },
    { id: 3, title: 'Play a trivia round', points: 20, completed_today: false },
    { id: 4, title: 'Share a hot take', points: 5, completed_today: false },
    { id: 5, title: 'Upvote a community thread', points: 5, completed_today: false },
  ];
  res.json({ challenges });
});

// POST /api/games/challenges/:id/complete
router.post('/challenges/:id/complete', verifyToken, async (req, res) => {
  try {
    await awardPoints(req.user.id, 10, `challenge_${req.params.id}`);
    res.json({ ok: true, points_awarded: 10 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete challenge' });
  }
});

// GET /api/games/photo-contest
router.get('/photo-contest', verifyToken, async (req, res) => {
  try {
    const [entries] = await db.query(
      `SELECT p.id, p.media_url, p.caption, u.display_name, u.avatar_url,
              (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id) AS votes
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.deleted_at IS NULL ORDER BY votes DESC LIMIT 20`
    );
    res.json({ entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photo contest' });
  }
});

// POST /api/games/photo-contest/vote/:entryId
router.post('/photo-contest/vote/:entryId', verifyToken, async (req, res) => {
  try {
    await db.query(
      'INSERT IGNORE INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)',
      [req.params.entryId, req.user.id, '🏆']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// GET /api/games/breed-guess
router.get('/breed-guess', verifyToken, async (req, res) => {
  try {
    const [entries] = await db.query(
      `SELECT p.id, p.media_url, pp.breed AS actual_breed
       FROM posts p
       JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.media_url != '' AND p.deleted_at IS NULL
       ORDER BY RAND() LIMIT 5`
    );
    res.json({ entries: entries.map((e) => ({ ...e, actual_breed: undefined })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch breed guesses' });
  }
});

// POST /api/games/breed-guess/:entryId
router.post('/breed-guess/:entryId', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pp.breed AS actual_breed FROM posts p
       JOIN pet_profiles pp ON pp.id = p.pet_id WHERE p.id = ?`,
      [req.params.entryId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const actual_breed = rows[0].actual_breed;
    const correct = actual_breed.toLowerCase() === (req.body.guess || '').toLowerCase();
    if (correct) await awardPoints(req.user.id, 15, 'breed_guess_correct');
    res.json({ correct, actual_breed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit guess' });
  }
});

module.exports = router;
