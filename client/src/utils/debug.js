/**
 * Dev-only logger. V produkcii (import.meta.env.PROD === true) je no-op —
 * Vite DCE (dead code elimination) výraz úplne zahodí pri build-e, takže
 * nezaťažujú bundle ani runtime.
 *
 * Použitie:
 *   import { debug } from '../utils/debug';
 *   debug.log('[DeepLink] Tasks: processing', id);
 *
 * Pre skutočné chyby použi reportError() z utils/reportError — ide do
 * in-house Diagnostiky v AdminPaneli. Samotné console.error/warn sa nikam
 * neposielajú (Sentry je odstránený).
 */
const noop = () => {};

export const debug = import.meta.env.PROD
  ? { log: noop, info: noop, warn: noop }
  : {
      log: (...args) => console.log(...args),
      info: (...args) => console.info(...args),
      warn: (...args) => console.warn(...args)
    };
