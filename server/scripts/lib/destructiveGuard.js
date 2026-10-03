/**
 * Poistka pre skripty, ktoré mažú alebo prepisujú dáta.
 *
 * Skript sa spúšťa proti DB z MONGODB_URI — na vývojárskom stroji to často
 * býva produkcia. Bez oboch podmienok beží skript len ako dry-run (vypíše,
 * čo by urobil):
 *   - argument `--confirm`
 *   - env ALLOW_DESTRUCTIVE_SCRIPTS=true
 */
const isDestructiveRunAllowed = () =>
  process.argv.includes('--confirm') && process.env.ALLOW_DESTRUCTIVE_SCRIPTS === 'true';

const explainDryRun = (action) => {
  console.log(`\n[DRY-RUN] ${action} sa NEVYKONALO.`);
  console.log('Na ostrý beh: ALLOW_DESTRUCTIVE_SCRIPTS=true node <skript> --confirm');
};

const getArg = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

module.exports = { isDestructiveRunAllowed, explainDryRun, getArg };
