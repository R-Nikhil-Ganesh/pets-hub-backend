const router = require('express').Router();
const ChatMessage = require('../models/ChatMessage');
const { verifyToken } = require('../middleware/auth');
const { upload, uploadStream } = require('../middleware/upload');
const { canUserAccessCommunity } = require('../utils/communityAccess');
const db = require('../config/db');

function normalizeMessageReactions(message) {
  const aggregated = new Map();

  for (const reaction of Array.isArray(message.reactions) ? message.reactions : []) {
    const emoji = String(reaction.emoji || '').trim();
    if (!emoji) continue;

    if (!aggregated.has(emoji)) {
      aggregated.set(emoji, new Set());
    }

    const bucket = aggregated.get(emoji);
    if (Array.isArray(reaction.user_ids)) {
      reaction.user_ids.forEach((id) => bucket.add(Number(id)));
    } else if (reaction.user_id != null) {
      bucket.add(Number(reaction.user_id));
    }
  }

  message.reactions = Array.from(aggregated.entries()).map(([emoji, users]) => ({
    emoji,
    count: users.size,
    user_ids: Array.from(users).filter((id) => Number.isFinite(id)),
  }));
}

function normalizeReactionsForUser(reactions, userId) {
  const aggregated = new Map();

  for (const reaction of Array.isArray(reactions) ? reactions : []) {
    const emoji = String(reaction.emoji || '').trim();
    if (!emoji) continue;
    if (!aggregated.has(emoji)) {
      aggregated.set(emoji, new Set());
    }

    const bucket = aggregated.get(emoji);
    if (Array.isArray(reaction.user_ids)) {
      reaction.user_ids.forEach((id) => bucket.add(Number(id)));
    } else if (reaction.user_id != null) {
      bucket.add(Number(reaction.user_id));
    } else if (Number.isFinite(Number(reaction.count)) && Number(reaction.count) > 0) {
      const syntheticBase = emoji.codePointAt(0) || 0;
      for (let i = 0; i < Number(reaction.count); i += 1) {
        bucket.add(-(syntheticBase + i + 1));
      }
    }
  }

  return Array.from(aggregated.entries()).map(([emoji, users]) => {
    const userIds = Array.from(users).filter((id) => Number.isFinite(id));
    return {
      emoji,
      count: userIds.length,
      user_reacted: userIds.includes(Number(userId)),
      user_ids: userIds,
    };
  });
}

async function getReactionUsersMap(userIds) {
  const normalized = [...new Set(userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (normalized.length === 0) return new Map();

  const [rows] = await db.query(
    'SELECT id, username, display_name FROM users WHERE id IN (?)',
    [normalized]
  );
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.id), {
      id: Number(row.id),
      username: row.username,
      display_name: row.display_name || row.username,
    });
  });
  return map;
}

function enrichReactionsWithUsers(reactions, userId, usersMap) {
  return reactions.map((reaction) => {
    const userIds = Array.isArray(reaction.user_ids)
      ? reaction.user_ids.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0).map(Number)
      : [];

    const users = userIds.map((id) => {
      const user = usersMap.get(id);
      return {
        id,
        username: user?.username || `user${id}`,
        display_name: user?.display_name || user?.username || `User ${id}`,
        is_self: id === Number(userId),
      };
    });

    return {
      ...reaction,
      users,
    };
  });
}

function normalizeReplyTo(replyTo) {
  if (!replyTo) return null;
  if (typeof replyTo === 'string') return replyTo;
  if (typeof replyTo === 'object') {
    if (replyTo.message_id) return String(replyTo.message_id);
    return null;
  }
  return null;
}

// GET /api/chat/:communityId?before=<ISO>&limit=30
router.get('/:communityId', verifyToken, async (req, res) => {
  const communityId = Number(req.params.communityId);
  const limit = Number(req.query.limit) || 30;
  const before = req.query.before ? new Date(req.query.before) : new Date();

  if (!Number.isFinite(communityId) || communityId <= 0) {
    return res.status(400).json({ error: 'Invalid communityId' });
  }

  if (Number.isNaN(before.getTime())) {
    return res.status(400).json({ error: 'Invalid before timestamp' });
  }

  try {
    const access = await canUserAccessCommunity(req.user.id, communityId);
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const messages = await ChatMessage.find({
      community_id: communityId,
      deleted_at: null,
      createdAt: { $lt: before },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const baseMessages = messages.reverse().map((msg) => ({
      ...msg,
      sender_display_name: msg.sender_display_name || msg.sender_username || 'Unknown',
      reactions: normalizeReactionsForUser(msg.reactions, req.user.id),
      reply_to: normalizeReplyTo(msg.reply_to),
      reply_preview:
        msg.reply_preview ||
        (typeof msg.reply_to === 'object' && msg.reply_to?.content_preview
          ? String(msg.reply_to.content_preview)
          : null),
    }));

    const reactionUserIds = baseMessages.flatMap((msg) =>
      msg.reactions.flatMap((reaction) => (Array.isArray(reaction.user_ids) ? reaction.user_ids : []))
    );
    const usersMap = await getReactionUsersMap(reactionUserIds);
    const formattedMessages = baseMessages.map((msg) => ({
      ...msg,
      reactions: enrichReactionsWithUsers(msg.reactions, req.user.id, usersMap),
    }));

    res.json({ messages: formattedMessages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// POST /api/chat/:communityId/image — upload image for chat
router.post('/:communityId/image', verifyToken, upload.single('image'), async (req, res) => {
  const communityId = Number(req.params.communityId);
  if (!Number.isFinite(communityId) || communityId <= 0) {
    return res.status(400).json({ error: 'Invalid communityId' });
  }

  if (!req.file) return res.status(400).json({ error: 'Image required' });
  try {
    const access = await canUserAccessCommunity(req.user.id, communityId);
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    const url = await uploadStream(req.file.buffer, 'pawprint/chat');
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/chat/message/:messageId/react
router.post('/message/:messageId/react', verifyToken, async (req, res) => {
  const emoji = String(req.body?.emoji || '').trim();
  if (!emoji) return res.status(400).json({ error: 'emoji is required' });

  try {
    const msg = await ChatMessage.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const access = await canUserAccessCommunity(req.user.id, Number(msg.community_id));
    if (!access.exists) return res.status(404).json({ error: 'Community not found' });
    if (!access.allowed) {
      return res.status(403).json({
        error: `Access denied: this community requires a ${access.requiredSpecies} pet profile`,
      });
    }

    normalizeMessageReactions(msg);

    // Enforce one emoji per user: remove user from all reactions first.
    for (let i = msg.reactions.length - 1; i >= 0; i -= 1) {
      const reaction = msg.reactions[i];
      const userIds = Array.isArray(reaction.user_ids) ? reaction.user_ids.map(Number) : [];
      const userIdx = userIds.indexOf(req.user.id);
      if (userIdx >= 0) {
        userIds.splice(userIdx, 1);
        reaction.user_ids = userIds;
      }
      reaction.count = userIds.length;
      if (reaction.count <= 0) {
        msg.reactions.splice(i, 1);
      }
    }

    const targetIdx = msg.reactions.findIndex((r) => r.emoji === emoji);
    if (targetIdx >= 0) {
      const target = msg.reactions[targetIdx];
      const userIds = Array.isArray(target.user_ids) ? target.user_ids.map(Number) : [];
      if (!userIds.includes(req.user.id)) {
        userIds.push(req.user.id);
      }
      target.user_ids = userIds;
      target.count = userIds.length;
    } else {
      msg.reactions.push({ emoji, count: 1, user_ids: [req.user.id] });
    }

    await msg.save();

    const normalizedReactions = normalizeReactionsForUser(msg.reactions, req.user.id);
    const reactionUserIds = normalizedReactions.flatMap((reaction) => reaction.user_ids || []);
    const usersMap = await getReactionUsersMap(reactionUserIds);

    res.json({
      ok: true,
      message_id: String(msg._id),
      reactions: enrichReactionsWithUsers(normalizedReactions, req.user.id, usersMap),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to react to message' });
  }
});

// DELETE /api/chat/message/:messageId — soft delete own message
router.delete('/message/:messageId', verifyToken, async (req, res) => {
  try {
    const msg = await ChatMessage.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    msg.deleted_at = new Date();
    await msg.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
