const router = require('express').Router();
const db = require('../config/db');
const { client: redis } = require('../config/redis');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');

const TRIVIA_QUEUE_KEY = 'trivia:queue';
const DAILY_CHALLENGES = [
  { id: 1, title: 'Post a photo of your pet', description: 'Share one new post today.', points: 10 },
  { id: 2, title: 'Comment on 3 posts', description: 'Join the conversation on the feed.', points: 15 },
  { id: 3, title: 'Play a trivia round', description: 'Jump into a live trivia match.', points: 20 },
  { id: 4, title: 'Share a hot take', description: 'Post an opinion for the community.', points: 5 },
  { id: 5, title: 'Upvote a community thread', description: 'Support a useful thread or reply.', points: 5 },
];

router.post('/trivia/queue', verifyToken, async (req, res) => {
  try {
    await redis.zAdd(TRIVIA_QUEUE_KEY, { score: Date.now(), value: String(req.user.id) });

    const queued = await redis.zRangeWithScores(TRIVIA_QUEUE_KEY, 0, 1);
    if (queued.length >= 2) {
      const player1Id = Number(queued[0].value);
      const player2Id = Number(queued[1].value);
      await redis.zRem(TRIVIA_QUEUE_KEY, [String(player1Id), String(player2Id)]);

      const [questions] = await db.query('SELECT * FROM trivia_questions ORDER BY RAND() LIMIT 10');
      const [players] = await db.query(
        'SELECT id, username, display_name, avatar_url FROM users WHERE id IN (?, ?)',
        [player1Id, player2Id]
      );
      const playerMap = Object.fromEntries(players.map((player) => [Number(player.id), player]));
      const [result] = await db.query(
        'INSERT INTO game_sessions (mode, player1_id, player2_id, status) VALUES (?, ?, ?, ?)',
        ['trivia', player1Id, player2Id, 'active']
      );

      await redis.publish(
        'game:start',
        JSON.stringify({
          session_id: result.insertId,
          player1_id: player1Id,
          player2_id: player2Id,
          player1: playerMap[player1Id] || { id: player1Id },
          player2: playerMap[player2Id] || { id: player2Id },
          questions,
        })
      );
    }

    res.json({ ok: true, status: 'queued' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join queue' });
  }
});

router.delete('/trivia/queue', verifyToken, async (req, res) => {
  try {
    await redis.zRem(TRIVIA_QUEUE_KEY, String(req.user.id));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to leave queue' });
  }
});

router.post('/trivia/:sessionId/end', verifyToken, async (req, res) => {
  const { winner_id } = req.body;
  try {
    const [[session]] = await db.query(
      'SELECT id, status, player1_id, player2_id FROM game_sessions WHERE id = ?',
      [req.params.sessionId]
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.player1_id !== req.user.id && session.player2_id !== req.user.id) {
      return res.status(403).json({ error: 'Not a session participant' });
    }

    if (session.status === 'finished') {
      return res.json({ ok: true, already_finished: true, points_awarded: 0 });
    }

    await db.query('UPDATE game_sessions SET status = ?, winner_id = ? WHERE id = ?', [
      'finished',
      winner_id || null,
      req.params.sessionId,
    ]);

    const pointsWon = winner_id === req.user.id ? 100 : 20;
    await awardPoints(req.user.id, pointsWon, winner_id === req.user.id ? 'trivia_win' : 'trivia_played');
    await redis.zIncrBy('leaderboard:trivia', pointsWon, String(req.user.id));

    res.json({ ok: true, points_awarded: pointsWon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record result' });
  }
});

router.get('/leaderboard', verifyToken, async (req, res) => {
  try {
    const entries = await redis.zRangeWithScores('leaderboard:trivia', 0, 49, { REV: true });
    if (entries.length === 0) {
      return res.json({ leaderboard: [] });
    }

    const userIds = entries.map((entry) => Number(entry.value));
    const [users] = await db.query(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id IN (?)',
      [userIds]
    );
    const userMap = Object.fromEntries(users.map((user) => [user.id, user]));

    res.json({
      leaderboard: entries.map((entry, index) => ({
        rank: index + 1,
        user_id: Number(entry.value),
        score: Number(entry.score) || 0,
        points: Number(entry.score) || 0,
        ...userMap[Number(entry.value)],
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

router.get('/challenges', verifyToken, async (req, res) => {
  try {
    const [todayRows] = await db.query(
      `SELECT challenge_id
       FROM daily_challenge_completions
       WHERE user_id = ? AND challenge_date = CURRENT_DATE()`,
      [req.user.id]
    );
    const [totalRows] = await db.query(
      `SELECT challenge_id, COUNT(*) AS total_completed
       FROM daily_challenge_completions
       WHERE user_id = ?
       GROUP BY challenge_id`,
      [req.user.id]
    );
    const [activeRows] = await db.query(
      `SELECT COUNT(DISTINCT challenge_date) AS active_days
       FROM daily_challenge_completions
       WHERE user_id = ?`,
      [req.user.id]
    );

    const completedTodaySet = new Set(todayRows.map((row) => Number(row.challenge_id)));
    const totalsMap = new Map(totalRows.map((row) => [Number(row.challenge_id), Number(row.total_completed)]));
    const activeDays = Number(activeRows?.[0]?.active_days || 0);

    const challenges = DAILY_CHALLENGES.map((challenge) => {
      const totalCompleted = totalsMap.get(challenge.id) || 0;
      const completionRate = activeDays > 0 ? Math.round((totalCompleted / activeDays) * 100) : 0;
      return {
        ...challenge,
        points_reward: challenge.points,
        streak_count: totalCompleted,
        completed_today: completedTodaySet.has(challenge.id),
        completion_rate: completionRate,
      };
    });

    res.json({ challenges });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch challenges' });
  }
});

router.post('/challenges/:id/complete', verifyToken, async (req, res) => {
  try {
    const challengeId = Number(req.params.id);
    const challenge = DAILY_CHALLENGES.find((item) => item.id === challengeId);

    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    const [insertResult] = await db.query(
      `INSERT IGNORE INTO daily_challenge_completions (user_id, challenge_id, challenge_date)
       VALUES (?, ?, CURRENT_DATE())`,
      [req.user.id, challengeId]
    );

    const wasNewCompletion = Number(insertResult?.affectedRows || 0) > 0;
    if (wasNewCompletion) {
      await awardPoints(req.user.id, challenge.points, `challenge_${challengeId}`);
    }

    res.json({
      ok: true,
      already_completed: !wasNewCompletion,
      points_awarded: wasNewCompletion ? challenge.points : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete challenge' });
  }
});

router.get('/photo-contest', verifyToken, async (req, res) => {
  try {
    const entries = await getPhotoContestEntries(req.user.id);
    res.json({ entries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photo contest' });
  }
});

router.get('/photo-contest/active', verifyToken, async (req, res) => {
  try {
    const entries = await getPhotoContestEntries(req.user.id);
    res.json({
      contest: {
        id: 1,
        title: 'Weekly Photo Contest',
        description: 'Upload your best pet photo and vote for your favorites.',
        end_at: '',
        entry_count: entries.length,
        entries,
      },
      entries,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch photo contest' });
  }
});

router.post('/photo-contest/enter', verifyToken, upload.single('media'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Media is required' });
  }

  try {
    const media_url = await uploadStream(req.file.buffer, 'pawprint/contests');
    const [result] = await db.query(
      `INSERT INTO posts (user_id, pet_id, caption, media_url, media_type, location_name)
       VALUES (?, ?, ?, ?, 'image', '')`,
      [req.user.id, req.body.pet_id || null, req.body.caption || 'Photo contest entry', media_url]
    );
    res.status(201).json({ ok: true, entry_id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit contest entry' });
  }
});

router.post('/photo-contest/vote/:entryId', verifyToken, async (req, res) => {
  try {
    const entryId = Number(req.params.entryId);
    const [[existingVote]] = await db.query(
      'SELECT id FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?',
      [entryId, req.user.id, '🏆']
    );

    if (existingVote) {
      await db.query('DELETE FROM post_reactions WHERE id = ?', [existingVote.id]);
    } else {
      await db.query(
        `INSERT INTO post_reactions (post_id, user_id, emoji)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP`,
        [entryId, req.user.id, '🏆']
      );
    }

    const [[voteStats]] = await db.query(
      `SELECT
        COUNT(CASE WHEN emoji = '🏆' THEN 1 END) AS votes,
        COUNT(CASE WHEN emoji = '🏆' AND user_id = ? THEN 1 END) AS user_voted
       FROM post_reactions
       WHERE post_id = ?`,
      [req.user.id, entryId]
    );

    res.json({
      ok: true,
      voted: Number(voteStats?.user_voted || 0) > 0,
      votes: Number(voteStats?.votes || 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

router.get('/breed-guess', verifyToken, async (_req, res) => {
  try {
    const [entries] = await db.query(
      `SELECT p.id, p.media_url, pp.breed AS actual_breed
       FROM posts p
       JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.media_url != '' AND p.deleted_at IS NULL
       ORDER BY RAND() LIMIT 5`
    );
    const [breedRows] = await db.query(
      `SELECT DISTINCT breed FROM pet_profiles WHERE breed IS NOT NULL AND breed != '' ORDER BY breed ASC`
    );
    const allBreeds = breedRows.map((row) => row.breed);

    const randomizedEntries = entries.map((entry) => {
      const distractors = allBreeds
        .filter((breed) => breed !== entry.actual_breed)
        .sort(() => Math.random() - 0.5)
        .slice(0, 3);
      const options = [entry.actual_breed, ...distractors].sort(() => Math.random() - 0.5);
      return {
        id: entry.id,
        media_url: entry.media_url,
        options,
      };
    });

    res.json({ entries: randomizedEntries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch breed guesses' });
  }
});

router.post('/breed-guess/:entryId', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pp.breed AS actual_breed FROM posts p
       JOIN pet_profiles pp ON pp.id = p.pet_id WHERE p.id = ?`,
      [req.params.entryId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }

    const actual_breed = rows[0].actual_breed;
    const correct = actual_breed.toLowerCase() === (req.body.guess || '').toLowerCase();
    if (correct) {
      await awardPoints(req.user.id, 15, 'breed_guess_correct');
    }
    res.json({ correct, actual_breed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit guess' });
  }
});

module.exports = router;

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

async function getPhotoContestEntries(userId) {
  const [entries] = await db.query(
    `SELECT p.id, p.user_id, p.media_url, p.caption,
            u.username, u.display_name,
            COALESCE(pp.name, u.display_name) AS pet_name,
            COALESCE(pp.breed, '') AS pet_breed,
            (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id AND emoji = '🏆') AS votes,
            (SELECT COUNT(*) FROM post_reactions WHERE post_id = p.id AND user_id = ? AND emoji = '🏆') AS user_voted
     FROM posts p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
     WHERE p.deleted_at IS NULL AND p.media_url != ''
     ORDER BY votes DESC, p.created_at DESC LIMIT 20`,
    [userId]
  );

  return entries.map((entry) => ({
    id: entry.id,
    user_id: entry.user_id,
    username: entry.username,
    pet_name: entry.pet_name,
    pet_breed: entry.pet_breed,
    media_url: entry.media_url,
    votes: Number(entry.votes) || 0,
    user_voted: Number(entry.user_voted) > 0,
  }));
}
