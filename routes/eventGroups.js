const router = require('express').Router();
const db = require('../config/db');
const { verifyToken } = require('../middleware/auth');

const DUMMY_EVENTS = [
  {
    id: 9001,
    title: 'Sunrise Dog Walk & Pup Brunch',
    description: 'Easy 3km dog walk, photo corner, and treats after the walk.',
    location_name: 'Riverside Park',
    starts_at: '2026-03-29T07:30:00.000Z',
    cover_url: 'https://images.unsplash.com/photo-1507146426996-ef05306b995a?auto=format&fit=crop&w=1200&q=80',
  },
  {
    id: 9002,
    title: 'Cat Cafe Rescue Hangout',
    description: 'Meet adoptable cats, sip coffee, and join a mini care workshop.',
    location_name: 'Whiskers Cafe',
    starts_at: '2026-04-02T17:00:00.000Z',
    cover_url: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=1200&q=80',
  },
  {
    id: 9003,
    title: 'Pet First-Aid Bootcamp',
    description: 'Hands-on first aid demos with local vets and safety kits.',
    location_name: 'Pawprint Vet Hub',
    starts_at: '2026-04-05T10:00:00.000Z',
    cover_url: 'https://images.unsplash.com/photo-1601758228041-f3b2795255f1?auto=format&fit=crop&w=1200&q=80',
  },
  {
    id: 9004,
    title: 'Community Trick Challenge Night',
    description: 'Friendly trick challenge, judges panel, and fun prizes.',
    location_name: 'Downtown Pet Arena',
    starts_at: '2026-04-11T19:00:00.000Z',
    cover_url: 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=1200&q=80',
  },
];

router.get('/events', verifyToken, async (req, res) => {
  try {
    // Fetch groups created by user
    const [createdGroupRows] = await db.query(
      `SELECT id, event_id, name, community_id, created_at
       FROM event_groups
       WHERE creator_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    // Fetch groups user has accepted invite to
    const [joinedGroupRows] = await db.query(
      `SELECT g.id, g.event_id, g.name, g.community_id, g.created_at, g.creator_id
       FROM event_groups g
       JOIN event_group_requests r ON r.group_id = g.id
       WHERE r.invitee_id = ? AND r.status = 'accepted'
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );

    const allGroupRows = [...createdGroupRows, ...joinedGroupRows];
    const groupIds = allGroupRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    // Fetch user profile for member list
    const [[currentUser]] = await db.query(
      'SELECT id, display_name, avatar_url FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    );

    const membersByGroup = new Map();
    for (const row of allGroupRows) {
      const groupId = Number(row.id);
      membersByGroup.set(groupId, []);
      
      // Add creator to member list
      if (row.creator_id) {
        const [[creator]] = await db.query(
          'SELECT id, display_name, avatar_url FROM users WHERE id = ? LIMIT 1',
          [row.creator_id]
        );
        if (creator) {
          membersByGroup.get(groupId).push({
            id: Number(creator.id),
            display_name: creator.display_name,
            avatar_url: creator.avatar_url,
          });
        }
      }
    }

    if (groupIds.length > 0) {
      const [acceptedRows] = await db.query(
        `SELECT r.group_id, u.id, u.display_name, u.avatar_url
         FROM event_group_requests r
         JOIN users u ON u.id = r.invitee_id
         WHERE r.group_id IN (?) AND r.status = 'accepted'`,
        [groupIds]
      );

      for (const row of acceptedRows) {
        const groupId = Number(row.group_id);
        if (!membersByGroup.has(groupId)) continue;
        const bucket = membersByGroup.get(groupId);
        if (!bucket.some((member) => member.id === Number(row.id))) {
          bucket.push({
            id: Number(row.id),
            display_name: row.display_name,
            avatar_url: row.avatar_url,
          });
        }
      }
    }

    // Organize created groups by event
    const createdGroupsByEvent = new Map();
    for (const row of createdGroupRows) {
      const eventId = String(row.event_id);
      const groupId = Number(row.id);
      const members = membersByGroup.get(groupId) || [];
      if (!createdGroupsByEvent.has(eventId)) {
        createdGroupsByEvent.set(eventId, []);
      }
      createdGroupsByEvent.get(eventId).push({
        id: groupId,
        name: row.name,
        created_at: row.created_at,
        community_id: row.community_id ? Number(row.community_id) : null,
        member_count: members.length,
        members,
      });
    }

    // Organize joined groups by event
    const joinedGroupsByEvent = new Map();
    for (const row of joinedGroupRows) {
      const eventId = String(row.event_id);
      const groupId = Number(row.id);
      const members = membersByGroup.get(groupId) || [];
      if (!joinedGroupsByEvent.has(eventId)) {
        joinedGroupsByEvent.set(eventId, []);
      }
      joinedGroupsByEvent.get(eventId).push({
        id: groupId,
        name: row.name,
        created_at: row.created_at,
        community_id: row.community_id ? Number(row.community_id) : null,
        member_count: members.length,
        members,
      });
    }

    res.json({
      events: DUMMY_EVENTS.map((event) => ({
        ...event,
        created_groups: createdGroupsByEvent.get(String(event.id)) || [],
        joined_groups: joinedGroupsByEvent.get(String(event.id)) || [],
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

router.get('/connections', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              rel.is_follower, rel.is_following
       FROM users u
       JOIN (
         SELECT f.follower_id AS user_id, 1 AS is_follower, 0 AS is_following
         FROM follows f
         WHERE f.following_id = ?

         UNION ALL

         SELECT f.following_id AS user_id, 0 AS is_follower, 1 AS is_following
         FROM follows f
         WHERE f.follower_id = ?
       ) rel ON rel.user_id = u.id
       WHERE u.id <> ?
       ORDER BY u.display_name, u.username`,
      [req.user.id, req.user.id, req.user.id]
    );

    const merged = new Map();
    for (const row of rows) {
      const id = Number(row.id);
      if (!merged.has(id)) {
        merged.set(id, {
          id,
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          is_follower: Number(row.is_follower) > 0,
          is_following: Number(row.is_following) > 0,
        });
      } else {
        const current = merged.get(id);
        current.is_follower = current.is_follower || Number(row.is_follower) > 0;
        current.is_following = current.is_following || Number(row.is_following) > 0;
      }
    }

    res.json({ connections: Array.from(merged.values()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

router.get('/requests', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.id, r.group_id, r.invitee_id, r.status, r.created_at,
              g.event_id, g.name AS group_name, g.event_title, g.community_id,
              creator.id AS creator_id, creator.username AS creator_username,
              creator.display_name AS creator_display_name, creator.avatar_url AS creator_avatar_url
       FROM event_group_requests r
       JOIN event_groups g ON g.id = r.group_id
       JOIN users creator ON creator.id = g.creator_id
       WHERE r.invitee_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );

    res.json({
      requests: rows.map((row) => ({
        id: Number(row.id),
        group_id: Number(row.group_id),
        invitee_id: Number(row.invitee_id),
        status: row.status,
        created_at: row.created_at,
        event_id: row.event_id,
        group_name: row.group_name,
        event_title: row.event_title,
        community_id: row.community_id ? Number(row.community_id) : null,
        creator: {
          id: Number(row.creator_id),
          username: row.creator_username,
          display_name: row.creator_display_name,
          avatar_url: row.creator_avatar_url,
        },
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch group requests' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  const eventId = Number(req.body.event_id);
  const inviteeIds = Array.isArray(req.body.invitee_ids)
    ? [...new Set(req.body.invitee_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0 && id !== req.user.id))]
    : [];

  if (!Number.isFinite(eventId) || eventId <= 0) {
    return res.status(400).json({ error: 'event_id is required' });
  }

  if (inviteeIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one follower or following' });
  }

  const event = DUMMY_EVENTS.find((item) => item.id === eventId);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const connectionIds = await getConnectionIds(req.user.id);
  const unauthorized = inviteeIds.filter((id) => !connectionIds.has(id));
  if (unauthorized.length > 0) {
    return res.status(403).json({ error: 'You can only invite your followers/followings' });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const groupName = req.body.name?.trim() || `${event.title} Group`;
    const [groupInsert] = await connection.query(
      `INSERT INTO event_groups (event_id, event_title, creator_id, name)
       VALUES (?, ?, ?, ?)`,
      [String(event.id), event.title, req.user.id, groupName]
    );

    const groupId = Number(groupInsert.insertId);

    for (const inviteeId of inviteeIds) {
      const [requestInsert] = await connection.query(
        `INSERT INTO event_group_requests (group_id, invitee_id, status)
         VALUES (?, ?, 'pending')`,
        [groupId, inviteeId]
      );

      await connection.query(
        `INSERT INTO notifications (user_id, actor_id, type, ref_id, ref_type)
         VALUES (?, ?, 'game_invite', ?, 'event_group_request')`,
        [inviteeId, req.user.id, Number(requestInsert.insertId)]
      );
    }

    await connection.commit();

    res.status(201).json({
      ok: true,
      group: {
        id: groupId,
        event_id: event.id,
        event_title: event.title,
        name: groupName,
        invite_count: inviteeIds.length,
      },
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_rollbackErr) {}
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create event group' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/requests/:id/respond', verifyToken, async (req, res) => {
  const requestId = Number(req.params.id);
  const action = String(req.body.action || '').toLowerCase();

  if (!Number.isFinite(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [[request]] = await connection.query(
      `SELECT r.id, r.group_id, r.invitee_id, r.status,
              g.creator_id, g.name AS group_name, g.event_title, g.community_id
       FROM event_group_requests r
       JOIN event_groups g ON g.id = r.group_id
       WHERE r.id = ?
       LIMIT 1`,
      [requestId]
    );

    if (!request || Number(request.invitee_id) !== req.user.id) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      await connection.rollback();
      return res.status(409).json({ error: 'Request already handled' });
    }

    const nextStatus = action === 'accept' ? 'accepted' : 'declined';
    await connection.query(
      `UPDATE event_group_requests
       SET status = ?, responded_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextStatus, requestId]
    );

    if (action === 'decline') {
      await connection.commit();
      return res.json({ ok: true, status: 'declined' });
    }

    let communityId = request.community_id ? Number(request.community_id) : null;

    if (!communityId) {
      const communityName = `Event Crew: ${request.group_name || request.event_title}`.slice(0, 80);
      const [communityInsert] = await connection.query(
        `INSERT INTO communities (name, description, type, icon_emoji, is_default)
         VALUES (?, ?, 'topic', ?, 0)`,
        [
          communityName,
          `Private event group for ${request.event_title}.`,
          '🎉',
        ]
      );

      communityId = Number(communityInsert.insertId);

      await connection.query(
        'UPDATE event_groups SET community_id = ? WHERE id = ?',
        [communityId, request.group_id]
      );
    }

    await connection.query(
      'INSERT IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)',
      [communityId, Number(request.creator_id)]
    );

    const [acceptedRows] = await connection.query(
      `SELECT invitee_id
       FROM event_group_requests
       WHERE group_id = ? AND status = 'accepted'`,
      [request.group_id]
    );

    for (const row of acceptedRows) {
      await connection.query(
        'INSERT IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)',
        [communityId, Number(row.invitee_id)]
      );
    }

    await connection.commit();

    res.json({ ok: true, status: 'accepted', community_id: communityId });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_rollbackErr) {}
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to respond to request' });
  } finally {
    if (connection) connection.release();
  }
});

async function getConnectionIds(userId) {
  const [rows] = await db.query(
    `SELECT follower_id AS user_id
     FROM follows
     WHERE following_id = ?

     UNION

     SELECT following_id AS user_id
     FROM follows
     WHERE follower_id = ?`,
    [userId, userId]
  );

  return new Set(rows.map((row) => Number(row.user_id)).filter((id) => Number.isFinite(id) && id > 0));
}

module.exports = router;
