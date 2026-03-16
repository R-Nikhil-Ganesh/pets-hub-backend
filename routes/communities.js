const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// GET /api/communities?filter=my|discover&q=search
router.get('/', verifyToken, async (req, res) => {
  const { filter, q } = req.query;
  try {
    let query, params;
    if (filter === 'my') {
      query = `
        SELECT c.*,
               (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
               1 AS is_member
        FROM communities c
        JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ?
        ${q ? 'WHERE c.name LIKE ?' : ''}
        ORDER BY c.name
      `;
      params = q ? [req.user.id, `%${q}%`] : [req.user.id];
    } else {
      query = `
        SELECT c.*,
               (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
               (SELECT COUNT(*) FROM community_members WHERE community_id = c.id AND user_id = ?) AS is_member
        FROM communities c
        ${q ? 'WHERE c.name LIKE ?' : ''}
        ORDER BY member_count DESC
        LIMIT 50
      `;
      params = q ? [req.user.id, `%${q}%`] : [req.user.id];
    }
    const [rows] = await db.query(query, params);
    res.json({
      communities: rows.map((r) => ({ ...r, member_count: Number(r.member_count), is_member: Number(r.is_member) > 0 })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch communities' });
  }
});

// GET /api/communities/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id AND user_id = ?) AS is_member
       FROM communities c WHERE c.id = ?`,
      [req.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Community not found' });
    res.json({ community: { ...row, member_count: Number(row.member_count), is_member: Number(row.is_member) > 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch community' });
  }
});

// POST /api/communities/:id/join
router.post('/:id/join', verifyToken, async (req, res) => {
  try {
    await db.query(
      'INSERT IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join community' });
  }
});

// DELETE /api/communities/:id/join
router.delete('/:id/join', verifyToken, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM community_members WHERE community_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to leave community' });
  }
});

module.exports = router;
