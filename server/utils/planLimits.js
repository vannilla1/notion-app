/**
 * planLimits.js — jediný zdroj limitu členov workspace podľa plánu vlastníka
 * a zoznamu „Team Pro“ e-mailov (bypass limitu).
 *
 * Predtým bola tá istá logika (mapa limitov + parsovanie PRO_EMAILS s
 * natvrdo zapísanými osobnými e-mailmi) skopírovaná na 8 miestach a miestami
 * sa líšila (chýbajúci 'pro', iný fallback).
 */
const logger = require('./logger');

// Zachované LEN ako dočasný fallback, kým nie je v produkcii nastavená env
// premenná PRO_EMAILS — bez nej by tieto účty po nasadení stratili bypass
// limitu. Po nastavení PRO_EMAILS (aj prázdnej) sa nepoužije; potom ho
// treba z kódu odstrániť.
const LEGACY_PRO_EMAILS = ['project.manager@eperun.sk', 'martin.kosco@eperun.sk'];

const SEAT_LIMITS = { free: 2, trial: 2, team: 10, pro: Infinity };

let warnedMissingEnv = false;

const getProEmails = () => {
  const raw = process.env.PRO_EMAILS;
  if (raw === undefined) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      logger.warn('[planLimits] PRO_EMAILS nie je nastavené — používam dočasný legacy zoznam; nastavte env premennú');
    }
    return LEGACY_PRO_EMAILS;
  }
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
};

const isProEmail = (email) =>
  typeof email === 'string' && email.length > 0 && getProEmails().includes(email.trim().toLowerCase());

// Základný počet miest pre plán (Infinity = bez limitu). Neznámy plán = free.
const getBaseSeatLimit = (plan) => (Object.prototype.hasOwnProperty.call(SEAT_LIMITS, plan) ? SEAT_LIMITS[plan] : SEAT_LIMITS.free);

// Maximum členov vrátane dokúpených miest.
const getMaxMembers = (plan, paidSeats = 0) => {
  const base = getBaseSeatLimit(plan);
  return base === Infinity ? Infinity : base + (Number(paidSeats) || 0);
};

module.exports = { getProEmails, isProEmail, getBaseSeatLimit, getMaxMembers, SEAT_LIMITS };
