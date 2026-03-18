const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const ChatMessage = require('./models/ChatMessage');
const { client: redis } = require('./config/redis');
const db = require('./config/db');
const { canUserAccessCommunity } = require('./utils/communityAccess');

let io;

function toObjectIdString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof value.toString === 'function') {
    return value.toString();
  }
  return null;
}

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

function formatReactionsForClient(reactions, currentUserId, usersMap) {
  return (Array.isArray(reactions) ? reactions : []).map((reaction) => {
    const userIds = Array.isArray(reaction.user_ids)
      ? reaction.user_ids.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0).map(Number)
      : [];

    return {
      emoji: reaction.emoji,
      count: userIds.length,
      user_reacted: userIds.includes(Number(currentUserId)),
      user_ids: userIds,
      users: userIds.map((id) => {
        const user = usersMap.get(id);
        return {
          id,
          username: user?.username || `user${id}`,
          display_name: user?.display_name || user?.username || `User ${id}`,
          is_self: id === Number(currentUserId),
        };
      }),
    };
  });
}

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN || '*', credentials: true },
    transports: ['websocket', 'polling'],
  });

  // Auth middleware — validates JWT token in handshake
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    const username = socket.user.username;

    socket.join(`user:${userId}`);

    // --- Community chat ---
    socket.on('join:community', async (communityId) => {
      const parsedCommunityId = Number(communityId);
      if (!Number.isFinite(parsedCommunityId) || parsedCommunityId <= 0) return;

      try {
        const access = await canUserAccessCommunity(userId, parsedCommunityId);
        if (!access.exists || !access.allowed) {
          socket.emit('chat:error', {
            message: access.exists
              ? `Access denied: this community requires a ${access.requiredSpecies} pet profile`
              : 'Community not found',
          });
          return;
        }

        socket.join(`community:${parsedCommunityId}`);
      } catch (err) {
        console.error('join:community error', err);
      }
    });

    socket.on('leave:community', (communityId) => {
      socket.leave(`community:${communityId}`);
    });

    socket.on('chat:send', async (payload) => {
      const {
        community_id,
        content,
        type = 'text',
        media_url = '',
        reply_to,
        reply_preview,
      } = payload;
      if (!community_id) return;

      try {
        const parsedCommunityId = Number(community_id);
        if (!Number.isFinite(parsedCommunityId) || parsedCommunityId <= 0) return;

        const access = await canUserAccessCommunity(userId, parsedCommunityId);
        if (!access.exists || !access.allowed) {
          socket.emit('chat:error', {
            message: access.exists
              ? `Access denied: this community requires a ${access.requiredSpecies} pet profile`
              : 'Community not found',
          });
          return;
        }

        // Fetch user's display_name
        const [[user]] = await db.query('SELECT display_name, avatar_url FROM users WHERE id = ?', [userId]);
        if (!user) return;

        const msg = await ChatMessage.create({
          community_id: parsedCommunityId,
          sender_id: userId,
          sender_username: username,
          sender_display_name: user.display_name || username,
          sender_avatar: user.avatar_url || '',
          type,
          content: content?.trim() || '',
          media_url,
          reply_to: toObjectIdString(reply_to),
          reply_preview: String(reply_preview || '').trim() || null,
        });

        const msgObj = msg.toObject();
        // Format reactions for emission
        const formattedMsg = {
          ...msgObj,
          sender_display_name: msgObj.sender_display_name || msgObj.sender_username || 'Unknown',
          reply_to:
            typeof msgObj.reply_to === 'string'
              ? msgObj.reply_to
              : msgObj.reply_to?.message_id
                ? String(msgObj.reply_to.message_id)
                : null,
          reply_preview:
            msgObj.reply_preview ||
            (msgObj.reply_to?.content_preview ? String(msgObj.reply_to.content_preview) : null),
          reactions: (msgObj.reactions || []).map((r) => ({
            emoji: r.emoji,
            count: r.count || 1,
            user_reacted: Array.isArray(r.user_ids) && r.user_ids.includes(userId),
          })),
        };

        io.to(`community:${parsedCommunityId}`).emit('chat:message', formattedMsg);
      } catch (err) {
        console.error('chat:send error', err);
        socket.emit('chat:error', { message: 'Failed to send message' });
      }
    });

    socket.on('chat:react', async ({ message_id, emoji }) => {
      try {
        const emojiValue = String(emoji || '').trim();
        if (!emojiValue) return;

        const msg = await ChatMessage.findById(message_id);
        if (!msg) return;

        const access = await canUserAccessCommunity(userId, Number(msg.community_id));
        if (!access.exists || !access.allowed) return;

        normalizeMessageReactions(msg);
        
        // Enforce one emoji per user: remove user from all existing reactions first.
        for (let i = msg.reactions.length - 1; i >= 0; i -= 1) {
          const reaction = msg.reactions[i];
          const userIds = Array.isArray(reaction.user_ids) ? reaction.user_ids.map(Number) : [];
          const userIdx = userIds.indexOf(userId);
          if (userIdx >= 0) {
            userIds.splice(userIdx, 1);
          }
          reaction.user_ids = userIds;
          reaction.count = userIds.length;
          if (reaction.count <= 0) {
            msg.reactions.splice(i, 1);
          }
        }

        const targetIdx = msg.reactions.findIndex((r) => r.emoji === emojiValue);
        if (targetIdx >= 0) {
          const target = msg.reactions[targetIdx];
          const userIds = Array.isArray(target.user_ids) ? target.user_ids.map(Number) : [];
          if (!userIds.includes(userId)) {
            userIds.push(userId);
          }
          target.user_ids = userIds;
          target.count = userIds.length;
        } else {
          msg.reactions.push({ emoji: emojiValue, count: 1, user_ids: [userId] });
        }
        
        await msg.save();

        const reactionUserIds = msg.reactions.flatMap((reaction) =>
          Array.isArray(reaction.user_ids) ? reaction.user_ids : []
        );
        const usersMap = await getReactionUsersMap(reactionUserIds);
        
        // Format reactions for client
        const formattedReactions = formatReactionsForClient(msg.reactions, userId, usersMap);
        
        io.to(`community:${msg.community_id}`).emit('chat:reaction', {
          message_id,
          reactions: formattedReactions,
        });
      } catch (err) {
        console.error('chat:react error', err);
      }
    });

    // --- Trivia game ---
    socket.on('game:answer', (data) => {
      // Broadcast score update to match participants
      if (data.session_id) {
        io.to(`game:${data.session_id}`).emit('game:score', {
          user_id: userId,
          score: data.score,
        });
      }
    });

    socket.on('join:game', (sessionId) => {
      socket.join(`game:${sessionId}`);
    });

    socket.on('disconnect', () => {
      // Clean up game rooms if needed — handled per session lifecycle
    });
  });

  // Subscribe to Redis pub/sub for trivia matchmaking events.
  const subscriber = redis.duplicate();
  subscriber.on('error', (err) => {
    console.error('Redis subscriber error:', err?.message || err);
  });

  const subscribeGameStart = async () => {
    try {
      if (!subscriber.isOpen) {
        await subscriber.connect();
      }

      await subscriber.subscribe('game:start', (message) => {
        try {
          const data = JSON.parse(message);
          const { session_id, player1_id, player2_id, questions } = data;

          const formatQuestions = questions.map((q) => ({
            id: q.id,
            question: q.question,
            options: [q.choice_a, q.choice_b, q.choice_c, q.choice_d],
            correct_index: q.correct_index,
            time_limit: 20,
            category: q.category,
          }));

          io.sockets.sockets.forEach((s) => {
            if (s.user?.id === player1_id || s.user?.id === player2_id) {
              const opponentId = s.user.id === player1_id ? player2_id : player1_id;
              s.join(`game:${session_id}`);
              s.emit('game:start', {
                session_id,
                opponent: { id: opponentId },
                questions: formatQuestions,
              });
            }
          });
        } catch (err) {
          console.error('game:start sub handler error', err);
        }
      });

      console.log('Redis subscriber connected: game:start');
    } catch (err) {
      console.error('Redis subscriber connect/subscribe failed:', err?.message || err);
      setTimeout(subscribeGameStart, 5000);
    }
  };

  subscribeGameStart();

  return io;
}

function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { initSocket, emitToUser };
