const { createClient } = require('redis');

const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

async function initRedis() {
  client.on('error', (err) => console.error('Redis error:', err));
  await client.connect();
  console.log('Redis connected');
}

module.exports = { client: client, initRedis };
