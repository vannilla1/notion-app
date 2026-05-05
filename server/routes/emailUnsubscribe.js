const express = require('express');
const User = require('../models/User');
const logger = require('../utils/logger');
const { verifyUnsubscribeToken } = require('../services/subscriptionEmailService');

const router = express.Router();

/**
 * Public unsubscribe endpoint linked from email footers.
 *
 * Token = base64url("<userId>.<unixTs>.<HMAC-SHA256-32>") signed with JWT_SECRET.
 * No auth required — token itself is the proof. Tokens don't expire (link
 * stays valid forever) — easy for users who archive emails and unsubscribe
 * months later.
 *
 * One-click flow: click → marketingEmails=false + simple HTML confirmation.
 * GDPR-friendly: covers Article 21 (right to object to direct marketing).
 */
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send(renderResult({
      ok: false,
      title: 'Neplatný odkaz',
      message: 'Odkaz je neúplný alebo poškodený. Vráťte sa do aplikácie a vypnite si pripomienky v profile.'
    }));
  }

  const userId = verifyUnsubscribeToken(String(token));
  if (!userId) {
    return res.status(400).send(renderResult({
      ok: false,
      title: 'Neplatný odkaz',
      message: 'Tento odhlasovací odkaz nie je platný. Skopírujte ho prosím priamo z emailu, alebo si pripomienky vypnite v profile.'
    }));
  }

  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { 'preferences.marketingEmails': false } },
      { new: true }
    ).select('email preferences');

    if (!user) {
      return res.status(404).send(renderResult({
        ok: false,
        title: 'Účet nenájdený',
        message: 'Účet už neexistuje. Pripomienky vám preto nebudú chodiť.'
      }));
    }

    logger.info('[Unsubscribe] User opted out of marketing emails', { userId, email: user.email });

    return res.send(renderResult({
      ok: true,
      title: 'Odhlásenie potvrdené',
      message: `Pripomienky a marketingové emaily sme vypli pre <strong>${user.email}</strong>. Transakčné emaily (zmeny účtu, obnova hesla) vám budú chodiť ďalej.`
    }));
  } catch (err) {
    logger.error('[Unsubscribe] Failed', { error: err.message });
    return res.status(500).send(renderResult({
      ok: false,
      title: 'Chyba',
      message: 'Nastala chyba pri spracovaní. Skúste to prosím znova alebo nám napíšte na support@prplcrm.eu.'
    }));
  }
});

const renderResult = ({ ok, title, message }) => `
<!DOCTYPE html>
<html lang="sk"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — PrplCRM</title>
<style>
  body { margin:0; padding:0; background:#f4f4f7; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:520px; margin:60px auto; padding:0 16px; }
  .card { background:#fff; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,0.06); overflow:hidden; }
  .head { background:linear-gradient(135deg,#8B5CF6,#6D28D9); padding:28px; text-align:center; color:#fff; }
  .head h1 { margin:0; font-size:22px; font-weight:700; }
  .body { padding:32px 28px; }
  .icon { font-size:48px; text-align:center; margin:0 0 16px; }
  .title { font-size:20px; color:#1f2937; margin:0 0 12px; text-align:center; font-weight:600; }
  .msg { font-size:15px; color:#4b5563; line-height:1.6; text-align:center; }
  .cta { display:block; margin:24px auto 0; padding:12px 28px; background:#8B5CF6; color:#fff; border-radius:8px; text-decoration:none; font-weight:600; text-align:center; max-width:200px; }
  .foot { text-align:center; padding:18px; color:#9ca3af; font-size:12px; background:#f9fafb; }
</style></head>
<body><div class="wrap"><div class="card">
  <div class="head"><h1>PrplCRM</h1></div>
  <div class="body">
    <div class="icon">${ok ? '✅' : '⚠️'}</div>
    <h2 class="title">${title}</h2>
    <p class="msg">${message}</p>
    <a href="https://prplcrm.eu/app" class="cta">Otvoriť CRM</a>
  </div>
  <div class="foot">PrplCRM · prplcrm.eu</div>
</div></div></body></html>`;

module.exports = router;
