const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { canUserAccessCommunity } = require('../utils/communityAccess');
const { upload, uploadStream } = require('../middleware/upload');

let threadsMediaColumnReady;

async function ensureThreadsMediaColumn() {
  if (threadsMediaColumnReady !== undefined) {
    return threadsMediaColumnReady;
  }

  const [rows] = await db.query("SHOW COLUMNS FROM threads LIKE 'media_url'");
  if (rows.length > 0) {
    threadsMediaColumnReady = true;
    return true;
  }

  await db.query("ALTER TABLE threads ADD COLUMN media_url VARCHAR(512) DEFAULT '' AFTER content");
  threadsMediaColumnReady = true;
  return true;
}

// GET /api/threads?community_id=&page=1
router.get('/', verifyToken, async (req, res) => {
  const { community_id, page = 1 } = req.query;
  if (!community_id) return res.status(400).json({ error: 'community_id required' });
  const limit = 20;
  const offset = (Number(page) - 1) * limit;
  try {
    const access = await canUserAccessCommunity(req.user.id, Number(community_id));
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const [threads] = await db.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url,
              u.is_professional, u.professional_type,
              (SELECT SUM(is_upvote) FROM thread_upvotes WHERE thread_id = t.id) AS upvote_count,
              (SELECT COUNT(*) FROM thread_replies WHERE thread_id = t.id AND deleted_at IS NULL) AS reply_count,
              (SELECT is_upvote FROM thread_upvotes WHERE thread_id = t.id AND user_id = ?) AS user_voted
       FROM threads t JOIN users u ON u.id = t.user_id
       WHERE t.community_id = ? AND t.deleted_at IS NULL
       ORDER BY upvote_count DESC, t.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, community_id, limit, offset]
    );
    res.json({
      threads: threads.map(shapeThread),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// GET /api/threads/:id — thread + replies
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [[thread]] = await db.query(
      `SELECT t.*, u.username, u.display_name, u.avatar_url, u.is_professional, u.professional_type,
              (SELECT SUM(is_upvote) FROM thread_upvotes WHERE thread_id = t.id) AS upvote_count,
              (SELECT COUNT(*) FROM thread_replies WHERE thread_id = t.id AND deleted_at IS NULL) AS reply_count,
              (SELECT is_upvote FROM thread_upvotes WHERE thread_id = t.id AND user_id = ?) AS user_voted
       FROM threads t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
      [req.user.id, req.params.id]
    );
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const access = await canUserAccessCommunity(req.user.id, Number(thread.community_id));
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const [replies] = await db.query(
      `SELECT r.*, u.username, u.display_name, u.avatar_url, u.is_professional, u.professional_type,
              (SELECT SUM(is_upvote) FROM thread_upvotes WHERE reply_id = r.id) AS upvote_count,
              (SELECT is_upvote FROM thread_upvotes WHERE reply_id = r.id AND user_id = ?) AS user_voted
       FROM thread_replies r JOIN users u ON u.id = r.user_id
       WHERE r.thread_id = ? AND r.deleted_at IS NULL
       ORDER BY r.created_at ASC`,
      [req.user.id, req.params.id]
    );

    // Build nested reply tree
    const rootReplies = [];
    const replyMap = {};
    replies.forEach((r) => {
      replyMap[r.id] = shapeReply(r);
    });
    replies.forEach((r) => {
      if (r.parent_id && replyMap[r.parent_id]) {
        replyMap[r.parent_id].children.push(replyMap[r.id]);
      } else {
        rootReplies.push(replyMap[r.id]);
      }
    });

    res.json({ thread: shapeThread(thread), replies: rootReplies });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// POST /api/threads — create thread
router.post('/', verifyToken, upload.single('media'), async (req, res) => {
  const { community_id, title, content, flair } = req.body;
  if (!community_id || !title?.trim()) return res.status(400).json({ error: 'community_id and title required' });
  try {
    const access = await canUserAccessCommunity(req.user.id, Number(community_id));
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    let mediaUrl = '';
    if (req.file) {
      const resourceType = req.file.mimetype?.startsWith('video') ? 'video' : 'image';
      mediaUrl = await uploadStream(req.file.buffer, 'pawprint/threads', resourceType);
    }

    await ensureThreadsMediaColumn();

    const [result] = await db.query(
      'INSERT INTO threads (community_id, user_id, title, content, media_url, flair) VALUES (?, ?, ?, ?, ?, ?)',
      [community_id, req.user.id, title.trim(), content?.trim() || '', mediaUrl, flair || null]
    );
    await awardPoints(req.user.id, 10, 'created_thread');
    const [[thread]] = await db.query('SELECT * FROM threads WHERE id = ?', [result.insertId]);
    res.status(201).json({ thread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// POST /api/threads/:id/replies — add reply
router.post('/:id/replies', verifyToken, async (req, res) => {
  const { content, parent_id, parent_reply_id } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  try {
    const [[thread]] = await db.query('SELECT id, community_id FROM threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const access = await canUserAccessCommunity(req.user.id, Number(thread.community_id));
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const [result] = await db.query(
      'INSERT INTO thread_replies (thread_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
      [req.params.id, req.user.id, parent_id || parent_reply_id || null, content.trim()]
    );
    await awardPoints(req.user.id, 5, 'replied_to_thread');
    const [[reply]] = await db.query(
      `SELECT r.*, u.username, u.display_name, u.avatar_url
       FROM thread_replies r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ reply: { ...shapeReply(reply), children: [] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// POST /api/threads/:id/vote
router.post('/:id/vote', verifyToken, async (req, res) => {
  const { is_upvote = true, reply_id } = req.body || {};
  try {
    if (reply_id) {
      const [[reply]] = await db.query(
        'SELECT r.id, t.community_id FROM thread_replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?',
        [reply_id]
      );
      if (!reply) return res.status(404).json({ error: 'Reply not found' });

      const access = await canUserAccessCommunity(req.user.id, Number(reply.community_id));
      if (!access.allowed) {
        return res.status(403).json({
          error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
        });
      }
    } else {
      const [[thread]] = await db.query('SELECT id, community_id FROM threads WHERE id = ?', [req.params.id]);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });

      const access = await canUserAccessCommunity(req.user.id, Number(thread.community_id));
      if (!access.allowed) {
        return res.status(403).json({
          error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
        });
      }
    }

    const id = reply_id ?? req.params.id;
    await db.query(
      `INSERT INTO thread_upvotes (thread_id, reply_id, user_id, is_upvote) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_upvote = ?`,
      [reply_id ? null : id, reply_id ?? null, req.user.id, is_upvote ? 1 : 0, is_upvote ? 1 : 0]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to vote' });
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

function shapeThread(thread) {
  return {
    ...thread,
    upvotes: Number(thread.upvote_count) || 0,
    reply_count: Number(thread.reply_count) || 0,
    user_upvoted: Number(thread.user_voted) > 0,
  };
}

function shapeReply(reply) {
  return {
    ...reply,
    upvotes: Number(reply.upvote_count) || 0,
    user_upvoted: Number(reply.user_voted) > 0,
    parent_reply_id: reply.parent_id ?? null,
    children: reply.children || [],
  };
}

module.exports = router;
