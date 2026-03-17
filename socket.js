const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const ChatMessage = require('./models/ChatMessage');
const { client: redis } = require('./config/redis');
const db = require('./config/db');

let io;

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
    socket.on('join:community', (communityId) => {
      socket.join(`community:${communityId}`);
    });

    socket.on('leave:community', (communityId) => {
      socket.leave(`community:${communityId}`);
    });

    socket.on('chat:send', async (payload) => {
      const { community_id, content, type = 'text', media_url = '', reply_to } = payload;
      if (!community_id) return;

      try {
        // Fetch user's display_name
        const [[user]] = await db.query('SELECT display_name, avatar_url FROM users WHERE id = ?', [userId]);
        if (!user) return;

        const msg = await ChatMessage.create({
          community_id: Number(community_id),
          sender_id: userId,
          sender_username: username,
          sender_display_name: user.display_name,
          sender_avatar: user.avatar_url || '',
          type,
          content: content?.trim() || '',
          media_url,
          reply_to: reply_to || null,
          reply_preview: null,
        });

        const msgObj = msg.toObject();
        // Format reactions for emission
        const formattedMsg = {
          ...msgObj,
          reactions: (msgObj.reactions || []).map((r) => ({
            emoji: r.emoji,
            count: r.count || 1,
            user_reacted: Array.isArray(r.user_ids) && r.user_ids.includes(userId),
          })),
        };

        io.to(`community:${community_id}`).emit('chat:message', formattedMsg);
      } catch (err) {
        console.error('chat:send error', err);
        socket.emit('chat:error', { message: 'Failed to send message' });
      }
    });

    socket.on('chat:react', async ({ message_id, emoji }) => {
      try {
        const msg = await ChatMessage.findById(message_id);
        if (!msg) return;
        
        const reactionIdx = msg.reactions.findIndex((r) => r.emoji === emoji);
        if (reactionIdx >= 0) {
          const reaction = msg.reactions[reactionIdx];
          const userIdx = reaction.user_ids.indexOf(userId);
          if (userIdx >= 0) {
            // User already reacted, remove reaction
            reaction.user_ids.splice(userIdx, 1);
            reaction.count--;
            if (reaction.count === 0) {
              msg.reactions.splice(reactionIdx, 1);
            }
          } else {
            // Add user to reaction
            reaction.user_ids.push(userId);
            reaction.count++;
          }
        } else {
          // New reaction
          msg.reactions.push({ emoji, count: 1, user_ids: [userId] });
        }
        
        await msg.save();
        
        // Format reactions for client
        const formattedReactions = msg.reactions.map((r) => ({
          emoji: r.emoji,
          count: r.count,
          user_reacted: r.user_ids.includes(userId),
        }));
        
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
