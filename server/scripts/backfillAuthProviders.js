/**
 * Migration: backfill authProviders + emailVerified pre existujúcich userov.
 *
 * Schéma pred OAuth update mala iba `password` (required). Po update sme
 * pridali `authProviders: [String]` a `emailVerified: Boolean`. Všetci
 * legacy useri musia dostať:
 *   - authProviders: ['password']  — vedia sa logiňovať mailom/heslom
 *   - emailVerified: true          — pri register-i sme overili email
 *                                    (assumption: existujúci useri prešli
 *                                    register flow alebo boli pridaní cez
 *                                    invite, čo tiež overuje email)
 *
 * Bezpečné na opakované spustenie — upravuje len záznamy, ktoré ešte nemajú
 * authProviders nastavené (Mongoose default by ich nastavil len pri novom
 * dokumente; pre existujúce dáta musíme migrovať explicitne).
 *
 * Použitie:
 *   node server/scripts/backfillAuthProviders.js
 *
 * Spúšťa sa raz po deploy schémy. Trvá ~5-10s na DB s ~1000 userov.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI / MONGO_URI env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[backfill-auth-providers] connected');

  // Krok 1: nastaviť authProviders: ['password'] pre userov bez tohto poľa
  // (alebo s prázdnym polom). Použitie $set namiesto upsert — neovplyvní
  // userov ktorí už majú authProviders nastavené (napr. test users).
  const noProvidersResult = await User.updateMany(
    {
      $or: [
        { authProviders: { $exists: false } },
        { authProviders: null },
        { authProviders: { $size: 0 } }
      ]
    },
    { $set: { authProviders: ['password'] } }
  );
  console.log('[backfill-auth-providers] set authProviders=[password]:', noProvidersResult.modifiedCount);

  // Krok 2: emailVerified default true pre všetkých legacy userov, ktorí ešte
  // nemajú toto pole. Existujúci useri prešli registráciou (validácia emailu)
  // alebo boli vytvorení cez invite flow (kde sme tiež overili email pred
  // accept-om). U OAuth-vytvorených userov to nastaví príslušný OAuth callback.
  const noEmailVerifiedResult = await User.updateMany(
    {
      $or: [
        { emailVerified: { $exists: false } },
        { emailVerified: null }
      ]
    },
    { $set: { emailVerified: true } }
  );
  console.log('[backfill-auth-providers] set emailVerified=true:', noEmailVerifiedResult.modifiedCount);

  // Krok 3: sanity check — vypíš počet userov bez hesla aj OAuth ID (= žiadny
  // login method). Tento stav by nemal nastať — ak nastane, je to dáta-bug.
  const orphans = await User.find({
    $and: [
      { $or: [{ password: null }, { password: { $exists: false } }] },
      { $or: [{ googleId: null }, { googleId: { $exists: false } }] },
      { $or: [{ appleId: null }, { appleId: { $exists: false } }] }
    ]
  }, 'email').lean();

  if (orphans.length > 0) {
    console.warn('[backfill-auth-providers] WARN: users without ANY login method:', orphans.length);
    orphans.forEach(u => console.warn('  -', u.email));
  } else {
    console.log('[backfill-auth-providers] sanity check OK — every user has at least one login method');
  }

  await mongoose.disconnect();
  console.log('[backfill-auth-providers] done');
}

if (require.main === module) {
  run().catch(err => {
    console.error('[backfill-auth-providers] error', err);
    process.exit(1);
  });
}

module.exports = { run };
