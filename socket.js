const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const ChatMessage = require('./models/ChatMessage');
const { client: redis } = require('./config/redis');
const db = require('./config/db');
const { canUserAccessCommunity } = require('./utils/communityAccess');

let io;
const TRIVIA_QUESTION_TIME_MS = 20 * 1000;
const TRIVIA_POINTS_PER_CORRECT = 100;
const TRIVIA_WIN_POINTS = 100;
const TRIVIA_PLAY_POINTS = 20;
const triviaSessions = new Map();

function sanitizeTriviaText(value, fallback = '') {
  const normalized = String(value ?? '')
    .replace(/\uFFFD/g, '')
    .replace(/[–—]/g, '-')
    .replace(/(\d)\?{2,}(\d)/g, '$1-$2')
    .replace(/\?{3,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized || fallback;
}

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

function clearTriviaTimer(sessionState) {
  if (sessionState?.timer) {
    clearTimeout(sessionState.timer);
    sessionState.timer = null;
  }
}

function scheduleTriviaTimeout(sessionId) {
  const sessionState = triviaSessions.get(sessionId);
  if (!sessionState || sessionState.finished) return;

  clearTriviaTimer(sessionState);
  sessionState.timer = setTimeout(async () => {
    const latest = triviaSessions.get(sessionId);
    if (!latest || latest.finished) return;
    await advanceTriviaQuestion(sessionId, 'timeout');
  }, TRIVIA_QUESTION_TIME_MS);
}

async function finalizeTriviaSession(sessionId) {
  const sessionState = triviaSessions.get(sessionId);
  if (!sessionState || sessionState.finished) return;

  sessionState.finished = true;
  clearTriviaTimer(sessionState);

  const [player1Id, player2Id] = sessionState.playerIds;
  const player1Score = Number(sessionState.scores[player1Id] || 0);
  const player2Score = Number(sessionState.scores[player2Id] || 0);
  const winnerId =
    player1Score > player2Score ? player1Id : player2Score > player1Score ? player2Id : null;

  try {
    await db.query(
      'UPDATE game_sessions SET status = ?, winner_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['finished', winnerId, sessionId]
    );

    for (const playerId of sessionState.playerIds) {
      const pointsWon = winnerId === playerId ? TRIVIA_WIN_POINTS : TRIVIA_PLAY_POINTS;
      await awardPoints(
        playerId,
        pointsWon,
        winnerId === playerId ? 'trivia_win' : 'trivia_played'
      );
      await redis.zIncrBy('leaderboard:trivia', pointsWon, String(playerId));
    }
  } catch (err) {
    console.error('finalizeTriviaSession error', err);
  }

  io.to(`game:${sessionId}`).emit('game:end', {
    winner_id: winnerId,
    scores: {
      [player1Id]: player1Score,
      [player2Id]: player2Score,
    },
  });

  triviaSessions.delete(sessionId);
}

async function advanceTriviaQuestion(sessionId, reason) {
  const sessionState = triviaSessions.get(sessionId);
  if (!sessionState || sessionState.finished || sessionState.advancing) return;

  sessionState.advancing = true;
  clearTriviaTimer(sessionState);

  try {
    const lastQuestionIndex = sessionState.questions.length - 1;
    if (sessionState.currentQuestion >= lastQuestionIndex) {
      await finalizeTriviaSession(sessionId);
      return;
    }

    sessionState.currentQuestion += 1;
    sessionState.answeredBy = new Set();

    io.to(`game:${sessionId}`).emit('game:question', {
      current_question: sessionState.currentQuestion,
      reason,
    });

    scheduleTriviaTimeout(sessionId);
  } finally {
    const latest = triviaSessions.get(sessionId);
    if (latest) {
      latest.advancing = false;
    }
  }
}

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
    socket.on('game:answer', async (data = {}) => {
      const sessionId = Number(data.session_id);
      const questionIndex = Number(data.question_index);
      const choiceIndex = Number(data.choice_index);
      if (!Number.isFinite(sessionId) || !Number.isFinite(questionIndex) || !Number.isFinite(choiceIndex)) {
        return;
      }

      const sessionState = triviaSessions.get(sessionId);
      if (!sessionState || sessionState.finished) return;
      if (!sessionState.playerIds.includes(userId)) return;
      if (sessionState.currentQuestion !== questionIndex) return;
      if (sessionState.answeredBy.has(userId)) return;

      const question = sessionState.questions[sessionState.currentQuestion];
      if (!question) return;

      const isCorrect = choiceIndex === Number(question.correct_index);
      if (isCorrect) {
        sessionState.scores[userId] = Number(sessionState.scores[userId] || 0) + TRIVIA_POINTS_PER_CORRECT;
      }

      sessionState.answeredBy.add(userId);

      io.to(`game:${sessionId}`).emit('game:score', {
        user_id: userId,
        score: Number(sessionState.scores[userId] || 0),
      });

      if (sessionState.answeredBy.size >= sessionState.playerIds.length) {
        await advanceTriviaQuestion(sessionId, 'all_answered');
      }
    });

    socket.on('join:game', (sessionId) => {
      socket.join(`game:${sessionId}`);
    });

    socket.on('disconnect', () => {
      // Clean up empty Event Crew communities when user leaves
      (async () => {
        try {
          const [communities] = await db.query(
            `SELECT c.id FROM communities c
             WHERE c.name LIKE 'Event Crew:%'
             AND (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) = 0`
          );
          
          if (communities && communities.length > 0) {
            for (const comm of communities) {
              await db.query('DELETE FROM communities WHERE id = ?', [comm.id]);
            }
          }
        } catch (err) {
          console.error('Failed to clean up empty Event Crew communities:', err);
        }
      })();
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
          const { session_id, player1_id, player2_id, player1, player2, questions } = data;

          const formatQuestions = questions.map((q) => ({
            id: q.id,
            question: sanitizeTriviaText(q.question, 'Trivia question'),
            options: [
              sanitizeTriviaText(q.choice_a, 'Option A'),
              sanitizeTriviaText(q.choice_b, 'Option B'),
              sanitizeTriviaText(q.choice_c, 'Option C'),
              sanitizeTriviaText(q.choice_d, 'Option D'),
            ],
            correct_index: q.correct_index,
            time_limit: 20,
            category: q.category,
          }));

          const sessionId = Number(session_id);
          const player1Id = Number(player1_id);
          const player2Id = Number(player2_id);
          triviaSessions.set(sessionId, {
            sessionId,
            playerIds: [player1Id, player2Id],
            questions: formatQuestions,
            currentQuestion: 0,
            scores: {
              [player1Id]: 0,
              [player2Id]: 0,
            },
            answeredBy: new Set(),
            timer: null,
            finished: false,
            advancing: false,
          });
          scheduleTriviaTimeout(sessionId);

          io.sockets.sockets.forEach((s) => {
            if (s.user?.id === player1_id || s.user?.id === player2_id) {
              const opponentId = s.user.id === player1_id ? player2_id : player1_id;
              const opponent = s.user.id === player1_id ? (player2 || { id: opponentId }) : (player1 || { id: opponentId });
              s.join(`game:${session_id}`);
              s.emit('game:start', {
                session_id,
                opponent,
                questions: formatQuestions,
                current_question: 0,
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
