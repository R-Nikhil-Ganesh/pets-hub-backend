const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => {
      // Exponential backoff with cap keeps Redis reconnects from hammering the network.
      return Math.min(1000 * 2 ** retries, 10000);
    },
    keepAlive: 5000,
  },
});

let listenersBound = false;

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  client.on('error', (err) => {
    console.error('Redis client error:', err?.message || err);
  });

  client.on('reconnecting', () => {
    console.warn('Redis reconnecting...');
  });

  client.on('ready', () => {
    console.log('Redis ready');
  });

  client.on('end', () => {
    console.warn('Redis connection ended');
  });
}

async function initRedis() {
  bindListeners();

  if (client.isOpen) return;

  try {
    await client.connect();
    console.log('Redis connected');
  } catch (err) {
    // Keep API alive without Redis; Redis-backed features will log and return 500 where needed.
    console.error('Redis initial connect failed:', err?.message || err);
  }
}

module.exports = { client: client, initRedis };
