require('./load-env');

const express      = require('express');
const cookieParser = require('cookie-parser');
const prisma       = require('./lib/prisma');

const analyticsRoutes = require('./routes/analytics.routes');

const app  = express();
const PORT = process.env.PORT || 3004;

app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'analytics' }));

app.use('/api/analytics', analyticsRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function shutdown(signal) {
  console.log(`[analytics] ${signal} received. Shutting down...`);
  await prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[analytics] Service running on :${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[analytics] Port ${PORT} is already in use. Stop the other process or change PORT in .env`
      );
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A stray throw outside the request path would otherwise crash the
  // process silently under Node's default behavior, taking down every
  // concurrently in-flight request with it — worst at peak load. Log with
  // full context and exit so the container's `restart: unless-stopped`
  // policy brings it back.
  process.on('uncaughtException', err => {
    console.error('[analytics] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', reason => {
    console.error('[analytics] unhandledRejection:', reason);
    process.exit(1);
  });
}

module.exports = app;
