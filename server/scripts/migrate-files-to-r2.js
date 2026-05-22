/**
 * migrate-files-to-r2.js
 *
 * ONE-OFF migration: presunúť všetky ContactFile.data (base64 strings v MongoDB)
 * do Cloudflare R2 bucket-u. Po behu by mali všetky records mať r2Key set
 * a data: null → uvoľní ~432 MB v Mongo Atlas free tier-i.
 *
 * BEZPEČNOSŤ:
 *   - Pred unset-om `data` overí že R2 upload reálne dorazil (HEAD request)
 *   - Pri chybe loguje a pokračuje ďalšími files (žiadny abort all-or-nothing)
 *   - Idempotentný: ak script bežal pre file už predtým a r2Key je set,
 *     preskočí ho. Pri opakovanom behu (recovery z chyby) je safe.
 *
 * SPUSTENIE:
 *   1. Skontroluj že R2 env vars sú nastavené (R2_ACCOUNT_ID atď.)
 *   2. node server/scripts/migrate-files-to-r2.js
 *   3. (voliteľné) Skript dryRun mode: node migrate-files-to-r2.js --dry-run
 *
 * Po dokončení script vypíše:
 *   - Počet migrovaných files
 *   - Počet preskočených (už migrované)
 *   - Počet chýb (logované jednotlivo)
 *   - Estimate ušetreného miesta v MongoDB
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const ContactFile = require('../models/ContactFile');
const fileStorage = require('../services/fileStorage');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 10; // process 10 súborov naraz, potom save + krátka pauza

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ContactFile → Cloudflare R2 Migration');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will modify DB + R2)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Sanity checks
  if (!fileStorage.isR2Available()) {
    console.error('❌ R2 nie je nakonfigurované! Skontroluj env vars:');
    console.error('   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET');
    process.exit(1);
  }
  console.log(`✓ R2 bucket: ${fileStorage.bucket}\n`);

  // MongoDB connection
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI environment variable not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ Connected to MongoDB\n');

  // Najprv prehľad — koľko files potrebuje migráciu
  const totalCount = await ContactFile.countDocuments({});
  const alreadyMigrated = await ContactFile.countDocuments({ r2Key: { $ne: null } });
  const needsMigration = await ContactFile.countDocuments({
    r2Key: null,
    data: { $ne: null, $exists: true }
  });
  const broken = await ContactFile.countDocuments({
    r2Key: null,
    $or: [{ data: null }, { data: { $exists: false } }]
  });

  console.log('Stav contactfiles kolekcie:');
  console.log(`   Celkom records:           ${totalCount}`);
  console.log(`   Už migrované (r2Key set): ${alreadyMigrated}`);
  console.log(`   Potrebujú migráciu:       ${needsMigration}`);
  console.log(`   Broken (žiadne dáta):     ${broken}`);
  console.log('');

  if (needsMigration === 0) {
    console.log('✅ Nič na migráciu — všetky files už majú r2Key alebo sú broken.');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Migrovalo by sa ${needsMigration} files. Spusti bez --dry-run flag-u.`);
    await mongoose.disconnect();
    return;
  }

  // Migrácia — cursor namiesto load-all aby sme nevyčerpali RAM pri 100+ MB files
  const cursor = ContactFile.find({
    r2Key: null,
    data: { $ne: null, $exists: true }
  }).cursor();

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let totalBytesMigrated = 0;

  console.log('Začínam migráciu...\n');

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    processed++;
    const fileId = doc.fileId;
    const r2Key = fileStorage.contactFileKey(fileId);
    const dataLen = doc.data?.length || 0;
    const estimatedBinarySize = Math.floor(dataLen * 0.75); // base64 → binary = ~75%

    process.stdout.write(`[${processed}/${needsMigration}] ${fileId} (${(dataLen / 1024).toFixed(1)} kB) ... `);

    try {
      // Decode base64 → Buffer
      const buffer = Buffer.from(doc.data, 'base64');

      // Upload do R2
      await fileStorage.uploadFile(r2Key, buffer, 'application/octet-stream');

      // Verify že dorazil (defensive)
      const exists = await fileStorage.fileExists(r2Key);
      if (!exists) throw new Error('R2 upload verification failed (fileExists returned false)');

      // Update DB record: set r2Key, unset data
      await ContactFile.updateOne(
        { _id: doc._id },
        { $set: { r2Key }, $unset: { data: '' } }
      );

      succeeded++;
      totalBytesMigrated += buffer.length;
      console.log(`✓ R2 OK (${(buffer.length / 1024).toFixed(1)} kB)`);
    } catch (err) {
      failed++;
      console.log(`✗ FAIL: ${err.message}`);
      // Pokračuj ďalším file-om, neabortuj
    }

    // Krátka pauza každých 10 files aby sme nezasiahli rate limit
    if (processed % BATCH_SIZE === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Migration complete');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Processed: ${processed}`);
  console.log(`   ✓ Succeeded: ${succeeded}`);
  console.log(`   ✗ Failed:    ${failed}`);
  console.log(`   Bytes migrated to R2: ${(totalBytesMigrated / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   ~ Estimated MongoDB space freed: ${(totalBytesMigrated * 1.33 / 1024 / 1024).toFixed(2)} MB (base64 overhead)`);
  console.log('');

  if (failed > 0) {
    console.log(`⚠️  ${failed} files zlyhalo. Spusti script znova — idempotentný, len failed files sa pokúsi znova.`);
  }

  // Po unset-e MongoDB ešte stále uchováva miesto v storage — treba compact.
  // Pre Atlas: storage size sa neaktualizuje okamžite, môže to trvať hodiny
  // (interný kompakcia + reclaim). Data size sa updatne hneď.
  console.log('💡 TIP: Po migrácii sa Atlas storage size aktualizuje s oneskorením');
  console.log('   (interná kompakcia). Data size klesne okamžite, storage size do hodín.');
  console.log('');

  await mongoose.disconnect();
  console.log('✓ Disconnected from MongoDB');
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err);
  process.exit(1);
});
