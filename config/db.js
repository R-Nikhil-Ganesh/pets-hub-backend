const mysql = require('mysql2/promise');

const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

function buildDbConfigFromUrl(urlString) {
  const parsed = new URL(urlString);
  const sslMode = (parsed.searchParams.get('ssl-mode') || parsed.searchParams.get('sslmode') || '').toUpperCase();
  const requireSslByMode = ['REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'].includes(sslMode);
  const requireSslByEnv = String(process.env.DB_SSL || '').toLowerCase() === 'true';

  const config = {
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : undefined,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    timezone: 'Z',
  };

  if (requireSslByMode || requireSslByEnv) {
    config.ssl = {
      rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false',
    };
  }

  return config;
}

const pool = mysql.createPool(
  databaseUrl
    ? buildDbConfigFromUrl(databaseUrl)
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'pawprint',
        waitForConnections: true,
        connectionLimit: 20,
        queueLimit: 0,
        timezone: 'Z',
      }
);

module.exports = pool;
