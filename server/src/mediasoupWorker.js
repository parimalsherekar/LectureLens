const mediasoup = require('mediasoup');
const config = require('./config');

let worker = null;

/**
 * Creates a single mediasoup Worker.
 * In production you'd create one worker per CPU core and round-robin routers across them.
 * For this project, one worker is sufficient.
 */
async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: config.worker.rtcMinPort,
    rtcMaxPort: config.worker.rtcMaxPort,
    logLevel: config.worker.logLevel,
    logTags: config.worker.logTags,
  });

  console.log(`[mediasoup] Worker created (pid: ${worker.pid})`);

  worker.on('died', (error) => {
    console.error('[mediasoup] Worker died:', error);
    // In production: restart worker or exit process
    process.exit(1);
  });

  return worker;
}

/**
 * Creates a mediasoup Router on the worker.
 * Each room gets its own Router so media stays isolated.
 */
async function createRouter() {
  if (!worker) throw new Error('Worker not initialized. Call createWorker() first.');

  const router = await worker.createRouter({
    mediaCodecs: config.router.mediaCodecs,
  });

  console.log(`[mediasoup] Router created (id: ${router.id})`);
  return router;
}

module.exports = { createWorker, createRouter };
