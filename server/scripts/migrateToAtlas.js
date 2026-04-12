#!/usr/bin/env node
/**
 * Migration script: Copy all data from current MongoDB to a new MongoDB (Atlas)
 *
 * Usage:
 *   node server/scripts/migrateToAtlas.js "mongodb+srv://user:pass@cluster.mongodb.net/prplcrm"
 *
 * Reads from current MONGODB_URI in .env, copies all collections to the new URI.
 * Uses cursors to read one document at a time (handles slow source servers).
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const SOURCE_URI = process.env.MONGODB_URI;
const TARGET_URI = process.argv[2];

if (!SOURCE_URI) {
  console.error('ERROR: MONGODB_URI not found in .env');
  process.exit(1);
}

if (!TARGET_URI) {
  console.error('Usage: node server/scripts/migrateToAtlas.js "mongodb+srv://user:pass@cluster.mongodb.net/dbname"');
  process.exit(1);
}

// Extract database name from URI
const getDbName = (uri) => {
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : 'prplcrm';
};

async function migrate() {
  console.log('Connecting to source MongoDB...');
  const sourceClient = new MongoClient(SOURCE_URI, {
    socketTimeoutMS: 300000, // 5 min timeout for slow server
    serverSelectionTimeoutMS: 30000,
  });

  console.log('Connecting to target MongoDB (Atlas)...');
  const targetClient = new MongoClient(TARGET_URI, {
    socketTimeoutMS: 60000,
    serverSelectionTimeoutMS: 30000,
  });

  try {
    await sourceClient.connect();
    await targetClient.connect();
    console.log('Both connections established.\n');

    const sourceDbName = getDbName(SOURCE_URI);
    const targetDbName = getDbName(TARGET_URI);

    const sourceDb = sourceClient.db(sourceDbName);
    const targetDb = targetClient.db(targetDbName);

    // Get all collections
    const collections = await sourceDb.listCollections().toArray();
    console.log(`Found ${collections.length} collections to migrate:\n`);

    for (const collInfo of collections) {
      const collName = collInfo.name;
      if (collName.startsWith('system.')) continue;

      const sourceColl = sourceDb.collection(collName);
      const targetColl = targetDb.collection(collName);

      const count = await sourceColl.countDocuments();
      console.log(`  ${collName}: ${count} documents`);

      if (count === 0) {
        console.log(`    → Skipped (empty)\n`);
        continue;
      }

      // Drop target collection if it exists (fresh migration)
      try {
        await targetColl.drop();
      } catch (e) {
        // Collection doesn't exist yet, that's fine
      }

      // Copy documents using cursor (one at a time)
      const cursor = sourceColl.find({}, { noCursorTimeout: true });
      let migrated = 0;
      const batch = [];
      const BATCH_SIZE = 50;

      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        batch.push(doc);

        if (batch.length >= BATCH_SIZE) {
          await targetColl.insertMany(batch, { ordered: false });
          migrated += batch.length;
          process.stdout.write(`    → ${migrated}/${count}\r`);
          batch.length = 0;
        }
      }

      // Insert remaining documents
      if (batch.length > 0) {
        await targetColl.insertMany(batch, { ordered: false });
        migrated += batch.length;
      }

      await cursor.close();
      console.log(`    → ${migrated}/${count} migrated ✓`);

      // Copy indexes
      try {
        const indexes = await sourceColl.indexes();
        for (const idx of indexes) {
          if (idx.name === '_id_') continue; // Skip default index
          const { key, ...options } = idx;
          delete options.v;
          delete options.ns;
          try {
            await targetColl.createIndex(key, options);
          } catch (idxErr) {
            console.log(`    ⚠ Index ${idx.name}: ${idxErr.message}`);
          }
        }
      } catch (idxErr) {
        console.log(`    ⚠ Index copy failed: ${idxErr.message}`);
      }

      console.log('');
    }

    console.log('\n✅ Migration complete!');
    console.log('\nNext steps:');
    console.log('1. Update MONGODB_URI on Render to the new Atlas URI');
    console.log('2. Redeploy the service');
    console.log('3. Test that everything works');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

migrate();
