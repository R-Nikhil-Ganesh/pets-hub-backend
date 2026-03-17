const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');

// GET /api/stories — active (not expired) stories grouped by user
router.get('/', verifyToken, async (req, res) => {
  try {
    const [stories] = await db.query(
      `SELECT s.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url,
              (SELECT COUNT(*) FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = ?) AS viewed
       FROM stories s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN pet_profiles pp ON pp.id = s.pet_id
       WHERE s.deleted_at IS NULL AND s.expires_at > NOW()
       ORDER BY u.id = ? DESC, s.created_at DESC`,
      [req.user.id, req.user.id]
    );
    res.json({
      stories: stories.map((s) => ({
        ...s,
        pet: s.pet_name
          ? {
              name: s.pet_name,
              breed: s.pet_breed || '',
              age: Number(s.pet_age) || 0,
              photo_url: s.pet_photo_url || '',
            }
          : null,
        viewed: Number(s.viewed) > 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// GET /api/stories/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [[story]] = await db.query(
      `SELECT s.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url
       FROM stories s JOIN users u ON u.id = s.user_id
       LEFT JOIN pet_profiles pp ON pp.id = s.pet_id
       WHERE s.id = ? AND s.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!story) return res.status(404).json({ error: 'Story not found' });
    res.json({ story });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

// POST /api/stories — create story
router.post('/', verifyToken, upload.single('media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Media is required' });

  try {
    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'Uploaded media file is empty' });
    }

    const mediaType = req.file.mimetype?.startsWith('video') ? 'video' : 'image';
    const resourceType = mediaType === 'video' ? 'video' : 'image';
    const media_url = await uploadStream(req.file.buffer, 'pawprint/stories', resourceType);
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { pet_id } = req.body;

    const [result] = await db.query(
      `INSERT INTO stories (user_id, pet_id, media_url, media_type, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, pet_id || null, media_url, mediaType, expires_at]
    );
    const [[story]] = await db.query(
      `SELECT s.*, u.username, u.display_name, u.avatar_url,
              pp.name AS pet_name, pp.breed AS pet_breed, pp.age AS pet_age, pp.photo_url AS pet_photo_url
       FROM stories s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN pet_profiles pp ON pp.id = s.pet_id
       WHERE s.id = ?`,
      [result.insertId]
    );
    res.status(201).json({ story });
  } catch (err) {
    console.error('create story failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to create story' });
  }
});

// POST /api/stories/:id/view
router.post('/:id/view', verifyToken, async (req, res) => {
  try {
    await db.query(
      'INSERT IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

module.exports = router;
