require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { initMongo } = require('./config/mongo');
const { initRedis } = require('./config/redis');
const { initCron } = require('./cron/storyExpiry');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api', limiter);

// --- Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/feed', require('./routes/feed'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/stories', require('./routes/stories'));
app.use('/api/hot-takes', require('./routes/hotTakes'));
app.use('/api/communities', require('./routes/communities'));
app.use('/api/threads', require('./routes/threads'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/games', require('./routes/games'));
app.use('/api/points', require('./routes/points'));

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// --- Boot ---
const PORT = process.env.PORT || 3001;

(async () => {
  await initMongo();
  await initRedis();
  initSocket(server);
  initCron();
  server.listen(PORT, () => console.log(`Pawprint API running on port ${PORT}`));
})();

module.exports = { app };
