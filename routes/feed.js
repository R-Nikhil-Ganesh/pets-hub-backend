const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { client: redis } = require('../config/redis');

const FEED_TTL = 300; // 5 minutes cache

// GET /api/feed?page=1&limit=10
router.get('/', verifyToken, async (req, res) => {
  const userId = req.user.id;
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const cacheKey = `feed:${userId}:${page}`;
  try {
    // Try cache on page 1 only
    if (page === 1) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    // Scored feed query with social proximity + recency
    const [rows] = await db.query(
      `SELECT p.*,
              u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              (SELECT COUNT(*) FROM post_reactions pr WHERE pr.post_id = p.id) AS reaction_count,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
              (SELECT COUNT(*) FROM post_reactions pr WHERE pr.post_id = p.id AND pr.user_id = ?) AS user_reacted,
              (
                0.3 * (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.user_id LIMIT 1)
                + 0.2 * (1 / (1 + TIMESTAMPDIFF(HOUR, p.created_at, NOW())))
              ) AS score
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN pet_profiles pp ON pp.id = p.pet_id
       WHERE p.deleted_at IS NULL
       ORDER BY score DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, userId, limit + 1, offset]
    );

    const has_more = rows.length > limit;
    const posts = rows.slice(0, limit).map(shapePost);
    const payload = { posts, has_more, page };

    if (page === 1) {
      await redis.setEx(cacheKey, FEED_TTL, JSON.stringify(payload));
    }

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

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
