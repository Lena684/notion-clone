import app from './src/app.js';
import { port } from './src/config.js';
import { db } from './src/database.js';
import { startNightlyExport } from './src/scheduler.js';

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Local Notes backend listening at http://127.0.0.1:${port}`);
});
const stopScheduler = startNightlyExport();

function shutdown() {
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
