'use strict';
/** Manual/cron entry point:  npm run backup  (or: node scripts/backup.js) */
const backup = require('../src/backup');

backup.runBackup({ reason: 'cli' }).then((res) => {
  if (res.result !== 'ok') {
    console.error('Backup failed:', res.error);
    process.exit(1);
  }
  process.exit(0);
});
