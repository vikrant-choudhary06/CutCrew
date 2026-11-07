const cron = require('node-cron');
const startCronJobs = () => {
  // Telegram storage (Phase 5): every 6 hours, confirm the Telegram messages of
  // up to 5 Ready videos not checked in 24 hours still exist. Lookup only (no
  // video download); only a confirmed missing part leaves playback.
  cron.schedule('17 */6 * * *', async () => {
    const config = require('../config/videoStorage').videoStorageConfig();
    if (!config.enabled) return;
    try {
      const adapter = require('../services/storedMediaRuntime').getAdapter(config);
      const result = await require('../services/storageMaintenance').revalidateDue({ adapter, limit: 5, mode: 'lookup' });
      if (result.checked) console.log(`Stored video check: ${result.checked} checked, ${result.problems.length} with problems`);
    } catch (error) {
      console.error('Stored video check failed:', error.code || error.message);
    }
  });
  // Weekly provider check (Sundays 04:30): every installed provider, four sample
  // movies, end to end. The result is shown in the admin panel (Providers).
  if (process.env.PROVIDER_CHECK_WEEKLY !== 'false') {
    cron.schedule('30 4 * * 0', async () => {
      const ok = await require('../services/providerCheck').run();
      const latest = require('../services/providerCheck').latest();
      console.log(`Weekly provider check ${ok ? 'finished' : 'did not finish'}: ${latest ? latest.working.join(', ') || 'no provider delivered video' : 'no report'}`);
    });
  }
  console.log('Cron jobs initialized.');
};

module.exports = startCronJobs;
