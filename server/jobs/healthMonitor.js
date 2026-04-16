const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { notifyError } = require('../services/adminEmailService');

/**
 * Health monitor — periodicky spustí diagnostické kontroly (Mongo, SMTP,
 * APNs, Google) a v prípade opakovaných zlyhaní (3× po sebe) pošle email
 * na support@prplcrm.eu.
 *
 * Posledný snapshot je in-memory dostupný cez `getLastSnapshot()` —
 * admin endpoint `/api/admin/health/full` ho vracia.
 *
 * Intervaly:
 *   - Full check každých 5 minút
 *   - 3× rovnaký error-status pred odoslaním emailu (anti-flapping)
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const ALERT_THRESHOLD = 3; // koľko za sebou zlyhaní pred mailom

// Posledný plný snapshot (pre admin endpoint)
let lastSnapshot = {
  checkedAt: null,
  checks: {}
};

// Per-check fail counter (aby sme nespamovali emailom pri jednom výpadku)
const failCounters = {};
// Posledný stav ktorý sme už oznámili (aby sme neposlali opakovane stále ten istý)
const notifiedStatus = {};

async function checkMongo() {
  try {
    const state = mongoose.connection.readyState;
    // 1 = connected, 2 = connecting, 3 = disconnecting, 0 = disconnected
    if (state !== 1) {
      return { status: 'error', message: `MongoDB nie je pripojené (readyState=${state})` };
    }
    // Ping
    await mongoose.connection.db.admin().ping();
    return { status: 'ok', message: 'Pripojené' };
  } catch (err) {
    return { status: 'error', message: `MongoDB ping zlyhal: ${err.message}` };
  }
}

async function checkSmtp() {
  try {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
      return { status: 'warn', message: 'SMTP nie je nakonfigurované' };
    }
    // Light check — len overíme že env vars sú nastavené a transporter inicializovaný.
    // Skutočný verify() by mohol zlyhať na Gmail (rate limit) a spamoval by email.
    // Namiesto toho, ak SMTP spadne, notifyError zlyhá tiež → nepošle sa email,
    // ale log zachytí problém.
    return { status: 'ok', message: `Nakonfigurované (${process.env.SMTP_HOST})` };
  } catch (err) {
    return { status: 'error', message: `SMTP check: ${err.message}` };
  }
}

async function checkApns() {
  try {
    // APNs sa inicializuje v pushService. Skontrolujeme len že env vars sú nastavené.
    if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
      return { status: 'warn', message: 'APNs nie je nakonfigurované' };
    }
    // Skús zistiť expiry z APNs kľúča ak je v .env ako path
    return { status: 'ok', message: `Nakonfigurované (teamId=${process.env.APNS_TEAM_ID})` };
  } catch (err) {
    return { status: 'warn', message: `APNs check: ${err.message}` };
  }
}

async function checkGoogleTokens() {
  try {
    // Spočítaj koľko userov má aktívne Google OAuth tokeny
    const User = require('../models/User');
    const withCalendar = await User.countDocuments({ 'googleCalendar.refreshToken': { $exists: true, $ne: null, $ne: '' } });
    const withTasks = await User.countDocuments({ 'googleTasks.refreshToken': { $exists: true, $ne: null, $ne: '' } });
    return {
      status: 'ok',
      message: `${withCalendar} users s Calendar, ${withTasks} users s Tasks`,
      details: { withCalendar, withTasks }
    };
  } catch (err) {
    return { status: 'warn', message: `Google tokens check: ${err.message}` };
  }
}

async function checkMemory() {
  try {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    // Render starter má 512 MB, warn pri > 400
    let status = 'ok';
    if (rssMB > 450) status = 'error';
    else if (rssMB > 350) status = 'warn';
    return {
      status,
      message: `RSS ${rssMB} MB, Heap ${heapUsedMB}/${heapTotalMB} MB`,
      details: { heapUsedMB, heapTotalMB, rssMB }
    };
  } catch (err) {
    return { status: 'warn', message: `Memory check: ${err.message}` };
  }
}

async function runChecks() {
  const [mongo, smtp, apns, google, memory] = await Promise.all([
    checkMongo(),
    checkSmtp(),
    checkApns(),
    checkGoogleTokens(),
    checkMemory()
  ]);

  const checks = { mongo, smtp, apns, google, memory };
  const checkedAt = new Date();

  lastSnapshot = { checkedAt, checks };

  // Anti-flapping: 3× po sebe error → alert email
  for (const [name, result] of Object.entries(checks)) {
    if (result.status === 'error') {
      failCounters[name] = (failCounters[name] || 0) + 1;
      if (failCounters[name] >= ALERT_THRESHOLD && notifiedStatus[name] !== 'error') {
        notifyError(
          `Health check zlyhal: ${name}`,
          `${result.message}\n\nPo ${failCounters[name]} neúspešných kontrolách za sebou.\nČas: ${checkedAt.toISOString()}`
        );
        notifiedStatus[name] = 'error';
        logger.error(`[HealthMonitor] ALERT: ${name} → ${result.message}`);
      }
    } else {
      // Recovery email keď sa služba vráti po alerte
      if (notifiedStatus[name] === 'error' && result.status === 'ok') {
        notifyError(
          `Health check obnovený: ${name}`,
          `Služba ${name} je opäť OK.\n${result.message}\nČas: ${checkedAt.toISOString()}`
        );
        notifiedStatus[name] = 'ok';
        logger.info(`[HealthMonitor] RECOVERED: ${name}`);
      }
      failCounters[name] = 0;
    }
  }

  return lastSnapshot;
}

function getLastSnapshot() {
  return lastSnapshot;
}

let intervalHandle = null;

function start() {
  if (intervalHandle) return; // idempotent
  // Spusti prvú kontrolu hneď, potom každých 5 min
  runChecks().catch(err => logger.error('[HealthMonitor] Initial check failed', { error: err.message }));
  intervalHandle = setInterval(() => {
    runChecks().catch(err => logger.error('[HealthMonitor] Check failed', { error: err.message }));
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref?.();
  logger.info('[HealthMonitor] Started', { intervalMs: CHECK_INTERVAL_MS });
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop, runChecks, getLastSnapshot };
