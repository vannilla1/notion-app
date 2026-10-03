/**
 * Text chyby, ktorý smie ísť klientovi v 5xx odpovedi.
 *
 * Interné `error.message` (Mongo, Google API/gaxios, stack detaily) nepatrí
 * do odpovede — prezrádza implementáciu a mätie používateľa. Zámerne
 * formulované hlášky (napr. „Google Tasks nedovolil vytvoriť nový task
 * list…“) sa označia `err.userFacing = true` a prejdú.
 */
const GENERIC = 'skúste to znova o chvíľu.';

const userFacingError = (err) => {
  if (err && err.userFacing === true && typeof err.message === 'string' && err.message.length <= 300) {
    return err.message;
  }
  return GENERIC;
};

module.exports = { userFacingError };
