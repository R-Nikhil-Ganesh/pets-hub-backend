const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const {
  getUserSpeciesSet,
  canAccessCommunityByName,
  canUserAccessCommunity,
} = require('../utils/communityAccess');

const DEFAULT_COMMUNITY_ICONS = {
  'general pet talk': 'https://i.pinimg.com/736x/15/24/5b/15245b93abd62b3392a99bfb1766d617.jpg',
  'dog lovers': 'https://images.ctfassets.net/sfnkq8lmu5d7/1wwJDuKWXF4niMBJE9gaSH/97b11bcd7d41039f3a8eb5c3350acdfd/2024-05-24_Doge_meme_death_-_Hero.jpg',
  'cat owners': 'https://stickerrs.com/cdn-cgi/image/format=auto,quality=80,width=300/wp-content/uploads/2024/03/Cat-Meme-Stickers-Featured-300x300.png',
  'vet tips & health': 'https://media.makeameme.org/created/please-help-me-596e8b.jpg',
};

function shapeCommunity(row) {
  const nameKey = String(row.name || '').trim().toLowerCase();
  const fallbackIconUrl = DEFAULT_COMMUNITY_ICONS[nameKey] || null;
  const iconEmoji = String(row.icon_emoji || '').trim();

  return {
    ...row,
    icon_url: row.icon_url || fallbackIconUrl,
    icon_emoji: iconEmoji && !/^\?+$/.test(iconEmoji) ? iconEmoji : '',
    member_count: Number(row.member_count),
    is_member: Number(row.is_member) > 0,
  };
}

// GET /api/communities?filter=my|discover&q=search
router.get('/', verifyToken, async (req, res) => {
  const { filter, q } = req.query;
  try {
    const speciesSet = await getUserSpeciesSet(req.user.id);
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
    const visibleRows = rows.filter((row) => canAccessCommunityByName(row.name, speciesSet));
    res.json({
      communities: visibleRows.map(shapeCommunity),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch communities' });
  }
});

// GET /api/communities/:id
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const access = await canUserAccessCommunity(req.user.id, Number(req.params.id));
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const [[row]] = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id AND user_id = ?) AS is_member
       FROM communities c WHERE c.id = ?`,
      [req.user.id, req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Community not found' });
    res.json({ community: shapeCommunity(row) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch community' });
  }
});

// GET /api/communities/:id/members
router.get('/:id/members', verifyToken, async (req, res) => {
  const communityId = Number(req.params.id);
  if (!Number.isFinite(communityId) || communityId <= 0) {
    return res.status(400).json({ error: 'Invalid community id' });
  }

  try {
    const access = await canUserAccessCommunity(req.user.id, communityId);
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const [[communityRow]] = await db.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id AND user_id = ?) AS is_member
       FROM communities c WHERE c.id = ?`,
      [req.user.id, communityId]
    );

    if (!communityRow) return res.status(404).json({ error: 'Community not found' });

    const [members] = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_professional, u.professional_type
       FROM community_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.community_id = ?
       ORDER BY cm.joined_at DESC, u.id DESC
       LIMIT 200`,
      [communityId]
    );

    res.json({
      community: shapeCommunity(communityRow),
      members: members.map((member) => ({
        ...member,
        is_professional: Number(member.is_professional) > 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch community members' });
  }
});

// POST /api/communities/:id/join
router.post('/:id/join', verifyToken, async (req, res) => {
  try {
    const access = await canUserAccessCommunity(req.user.id, Number(req.params.id));
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

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
