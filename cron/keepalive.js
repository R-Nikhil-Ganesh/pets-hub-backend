const cron = require('node-cron');

function initKeepalive() {
  // Run every hour: ping an internal health endpoint to prevent Onrender from spinning down
  cron.schedule('0 * * * *', async () => {
    try {
      // Ping the health endpoint to keep the dyno/instance warm
      // Use a simple sync request to minimize overhead
      const http = require('http');
      const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`;
      
      http.get(`${baseUrl}/health`, (res) => {
        if (res.statusCode === 200) {
          console.log(`[keepalive] Health check passed at ${new Date().toISOString()}`);
        } else {
          console.warn(`[keepalive] Health check returned status ${res.statusCode}`);
        }
      }).on('error', (err) => {
        console.error('[keepalive] Health check error:', err.message);
      });
    } catch (err) {
      console.error('[keepalive] Keepalive job error:', err.message);
    }
  });

  console.log('[cron] Keepalive job scheduled (every hour)');
}

module.exports = { initKeepalive };
