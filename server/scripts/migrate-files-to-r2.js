/**
 * migrate-files-to-r2.js — CLI wrapper okolo services/fileMigration.js
 *
 * Pre lokálne behy. Pre triggering z Render-u (kde sú env vars už) použi
 * admin endpoint: POST /api/admin/migration/contactfiles-to-r2.
 *
 * SPUSTENIE:
 *   node server/scripts/migrate-files-to-r2.js [--dry-run]
 *
 * Vyžaduje .env file v root projektu s:
 *   MONGODB_URI, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const { runContactFileMigration } = require('../services/fileMigration');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ContactFile → Cloudflare R2 Migration');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will modify DB + R2)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI environment variable not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ Connected to MongoDB\n');

  // Streamovanie progress logov — pri CLI chceme vidieť per-file output v reálnom čase.
  // Service interne pushuje do state.log, ale my chceme realtime priamo na stdout.
  // Riešenie: poll state každých 500ms a vypisuj nové log entries.
  const { getStatus } = require('../services/fileMigration');
  let lastLogIdx = 0;
  const interval = setInterval(() => {
    const status = getStatus();
    if (status.log.length > lastLogIdx) {
      for (let i = lastLogIdx; i < status.log.length; i++) {
        console.log(status.log[i]);
      }
      lastLogIdx = status.log.length;
    }
  }, 500);

  try {
    const result = await runContactFileMigration({ dryRun: DRY_RUN });

    // Flush zvyšok logov
    clearInterval(interval);
    const finalStatus = getStatus();
    for (let i = lastLogIdx; i < finalStatus.log.length; i++) {
      console.log(finalStatus.log[i]);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Final summary');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   Processed:        ${result.processed}`);
    console.log(`   ✓ Succeeded:      ${result.succeeded}`);
    console.log(`   ✗ Failed:         ${result.failed}`);
    console.log(`   Bytes to R2:      ${(result.totalBytesMigrated / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   ~ MongoDB freed:  ${result.estimatedMongoFreedMB} MB`);

    if (result.failed > 0) {
      console.log(`\n⚠️  ${result.failed} files zlyhalo. Spusti script znova — idempotentný.`);
      console.log('Top errors:');
      result.errors.slice(0, 5).forEach(e => {
        console.log(`   - ${e.fileId || 'global'}: ${e.message}`);
      });
    }
  } finally {
    clearInterval(interval);
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err);
  process.exit(1);
});
