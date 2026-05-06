const nodemailer = require('nodemailer');
const crypto = require('crypto');
const EmailLog = require('../models/EmailLog');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * subscriptionEmailService — všetky maily súvisiace s plánmi/zľavami.
 *
 * 6 typov:
 *   1. subscription_assigned — admin priradil plán (free→team, free→pro, …)
 *   2. discount_assigned     — admin pridal zľavu / freeMonths / planUpgrade
 *   3. welcome_pro           — first-time upgrade na team/pro (jednorazový per user)
 *   4. reminder_t7           — 7 dní pred paidUntil expiráciou
 *   5. reminder_t1           — 1 deň pred paidUntil expiráciou
 *   6. expired               — po auto-downgrade na free
 *   7. winback               — 14 dní po expirácii ak user neobnovil
 *
 * Každá funkcia:
 *  - skontroluje SMTP transporter
 *  - skontroluje cooldown (24h per user+type)
 *  - skontroluje opt-out (len pre marketing typy)
 *  - vyrenderuje HTML cez `wrapEmail()`
 *  - zavolá `sendAndLog()` ktorá pošle + uloží EmailLog
 *  - aktualizuje `User.subscription.notifications.<flag>SentAt` pre reminder/winback typy
 *
 * Volajúci NIKDY nepotrebuje await výsledok — fire-and-forget v admin
 * routes znamená že email zlyhanie neblokuje admin response. Volania zo
 * cronu await-ujú aby sequenced sweep nezahltil SMTP pool.
 */

let transporter = null;
let smtpInitialized = false;

const initTransporter = () => {
  if (smtpInitialized) return transporter;
  smtpInitialized = true;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_PORT === '465'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    logger.info('[SubscriptionEmail] SMTP transporter initialized');
    return transporter;
  }
  logger.warn('[SubscriptionEmail] SMTP not configured — subscription emails disabled');
  return null;
};

const FROM_DEFAULT = '"PrplCRM" <hello@prplcrm.eu>';
const APP_URL = () => (process.env.CLIENT_URL || 'https://prplcrm.eu') + '/app';
const SITE_URL = () => process.env.CLIENT_URL || 'https://prplcrm.eu';

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h per user+type

const REPLY_TO = process.env.SMTP_REPLY_TO || 'support@prplcrm.eu';
const SUPPORT_EMAIL = 'support@prplcrm.eu';

/**
 * Stripuje HTML do plain-text verzie pre multipart/alternative. Gmail/Yahoo
 * Bayesian filter chápe HTML-only ako podozrivé (typický pattern marketing
 * spamu). Multipart s plain-text fallbackom zlepšuje deliverability score.
 *
 * Jednoduchý regex stripper: odstráni style/script bloky, prevedie odkazy
 * na "text (URL)", odstráni tagy, dekóduje bežné entity, normalizuje
 * whitespace. Pre naše šablóny stačí — žiadne tabuľky-v-tabuľkách s
 * nested obsahom, ktoré by potrebovali full DOM parser.
 */
const htmlToText = (html) => {
  if (!html) return '';
  return html
    // remove style/script blocks completely
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // turn anchor tags into "text (url)"
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim();
      if (!cleanText) return href;
      if (cleanText === href) return href;
      return `${cleanText} (${href})`;
    })
    // br/p/li/h*/tr/div/table → newline
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    // strip remaining tags
    .replace(/<[^>]+>/g, '')
    // decode common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&euro;/g, '€')
    // normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const PROMO = {
  KEEP20:    process.env.PROMO_KEEP20    || 'KEEP20',     // 20% pri reminder T-7
  KEEP30:    process.env.PROMO_KEEP30    || 'LASTCALL30', // 30% pri reminder T-1
  COMEBACK30: process.env.PROMO_COMEBACK30 || 'COMEBACK30',// 30% pri expired
  WINBACK50: process.env.PROMO_WINBACK50 || 'WINBACK50'   // 50% pri winback
};

const PLAN_LABELS = {
  free: 'Free',
  team: 'Tím',
  pro: 'Pro'
};

// Marketing typy — gated by user.preferences.marketingEmails
const MARKETING_TYPES = new Set(['reminder_t7', 'reminder_t1', 'winback']);

// ─── Helpers ────────────────────────────────────────────────────────

const formatDateSk = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('sk-SK', { year: 'numeric', month: 'long', day: 'numeric' });
};

/**
 * Generate HMAC-signed unsubscribe token for the user's email opt-out link.
 * Verified server-side in routes/emailUnsubscribe.js. Same JWT_SECRET as auth
 * (we don't need a separate secret — token is low-stakes, only toggles a Bool).
 */
const buildUnsubscribeToken = (userId) => {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const payload = `${userId}.${Math.floor(Date.now() / 1000)}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
};

const buildUnsubscribeLink = (userId) => {
  const token = buildUnsubscribeToken(userId);
  return `${SITE_URL()}/api/email/unsubscribe?token=${token}`;
};

const wrapEmail = ({ headerSubtitle, bodyHtml, footerNote, unsubscribeLink }) => `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <tr><td style="background:linear-gradient(135deg,#8B5CF6,#6D28D9);padding:32px 28px;text-align:center;">
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">PrplCRM</h1>
        <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">${headerSubtitle}</p>
      </td></tr>
      <tr><td style="padding:32px 28px;">${bodyHtml}</td></tr>
      <tr><td style="background:#f9fafb;padding:16px 28px;text-align:center;">
        <p style="font-size:11px;color:#aaa;margin:0 0 6px;line-height:1.5;">
          ${footerNote || ''}
        </p>
        <p style="font-size:11px;color:#aaa;margin:0;">
          PrplCRM · <a href="${SITE_URL()}" style="color:#8B5CF6;text-decoration:none;">prplcrm.eu</a>
          ${unsubscribeLink ? ` · <a href="${unsubscribeLink}" style="color:#aaa;text-decoration:underline;">Odhlásiť odber pripomienok</a>` : ''}
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

const ctaButton = (label, href) => `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr><td align="center">
    <a href="${href}" style="display:inline-block;background:#8B5CF6;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">${label}</a>
  </td></tr>
</table>`;

// ─── Cooldown / opt-out ────────────────────────────────────────────

/**
 * Returns true if a previous email of the same `type` was sent to the same
 * user in the last COOLDOWN_MS milliseconds. Skips the new send to prevent
 * accidental spam (e.g. admin re-edits discount 3× in 5 minutes).
 */
const isWithinCooldown = async (userId, type) => {
  if (!userId) return false; // system mails / no-user — no cooldown
  const since = new Date(Date.now() - COOLDOWN_MS);
  const exists = await EmailLog.findOne({
    userId,
    type,
    status: 'sent',
    sentAt: { $gte: since }
  }).select('_id').lean();
  return !!exists;
};

/**
 * Central send + log helper. Always writes an EmailLog row, even when the
 * actual nodemailer call is skipped (cooldown, opt-out, no SMTP). That way
 * the admin panel shows what *would* have happened.
 *
 * Returns { ok: bool, status: 'sent'|'skipped_*'|'failed', logId: ObjectId }.
 */
const sendAndLog = async ({ user, toEmail, type, subject, html, context, triggeredBy }) => {
  const t = initTransporter();

  // 1. opt-out gate (marketing only)
  if (MARKETING_TYPES.has(type)) {
    const userDoc = user || (await User.findById(user?._id || user).select('preferences').lean());
    const optedOut = userDoc?.preferences?.marketingEmails === false;
    if (optedOut) {
      const log = await EmailLog.create({
        userId: user?._id || user?.id || null,
        toEmail, type, subject,
        fromAddress: process.env.SMTP_FROM || FROM_DEFAULT,
        status: 'skipped_optout',
        context: context || {},
        triggeredBy: triggeredBy || 'system'
      });
      logger.info('[SubscriptionEmail] Skipped (opt-out)', { userId: log.userId, type });
      return { ok: false, status: 'skipped_optout', logId: log._id };
    }
  }

  // 2. cooldown gate
  const userIdForCooldown = user?._id || user?.id || null;
  if (userIdForCooldown && (await isWithinCooldown(userIdForCooldown, type))) {
    const log = await EmailLog.create({
      userId: userIdForCooldown,
      toEmail, type, subject,
      fromAddress: process.env.SMTP_FROM || FROM_DEFAULT,
      status: 'skipped_cooldown',
      context: context || {},
      triggeredBy: triggeredBy || 'system'
    });
    logger.info('[SubscriptionEmail] Skipped (cooldown)', { userId: log.userId, type });
    return { ok: false, status: 'skipped_cooldown', logId: log._id };
  }

  // 3. SMTP gate
  if (!t) {
    const log = await EmailLog.create({
      userId: userIdForCooldown,
      toEmail, type, subject,
      fromAddress: process.env.SMTP_FROM || FROM_DEFAULT,
      status: 'skipped_no_smtp',
      htmlSnapshot: html,
      context: context || {},
      triggeredBy: triggeredBy || 'system'
    });
    logger.warn('[SubscriptionEmail] Skipped (no SMTP)', { type, toEmail });
    return { ok: false, status: 'skipped_no_smtp', logId: log._id };
  }

  // 4. actually send
  // Build mail options:
  //  - text alternative — multipart improves Bayesian score on Yahoo/Gmail
  //  - Reply-To — directs replies to a real human inbox (support@), not the
  //    no-reply hello@ — Gmail uses presence of valid Reply-To as positive signal
  //  - List-Unsubscribe + List-Unsubscribe-Post — RFC 8058 one-click,
  //    REQUIRED by Gmail and Yahoo bulk sender guidelines (Feb 2024). Gmail
  //    auto-renders native "Unsubscribe" button in inbox using these headers.
  //    Even transactional mails benefit from including it (no penalty,
  //    user can opt-out of all marketing this way).
  const userIdHeader = userIdForCooldown ? String(userIdForCooldown) : null;
  const unsubscribeUrl = userIdHeader ? buildUnsubscribeLink(userIdHeader) : null;

  const headers = {};
  if (unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  // Precedence: bulk for marketing types — signals to inbox providers that
  // this is not a 1:1 conversation, helps with proper threading and stops
  // auto-replies (vacation responders) from bouncing back.
  if (MARKETING_TYPES.has(type)) {
    headers['Precedence'] = 'bulk';
    headers['X-Auto-Response-Suppress'] = 'OOF, AutoReply';
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || FROM_DEFAULT,
      to: toEmail,
      replyTo: REPLY_TO,
      subject,
      html,
      text: htmlToText(html),
      headers
    });
    const log = await EmailLog.create({
      userId: userIdForCooldown,
      toEmail, type, subject,
      fromAddress: process.env.SMTP_FROM || FROM_DEFAULT,
      status: 'sent',
      htmlSnapshot: html,
      context: context || {},
      triggeredBy: triggeredBy || 'system'
    });
    logger.info('[SubscriptionEmail] Sent', { type, toEmail, userId: userIdForCooldown });
    return { ok: true, status: 'sent', logId: log._id };
  } catch (err) {
    const log = await EmailLog.create({
      userId: userIdForCooldown,
      toEmail, type, subject,
      fromAddress: process.env.SMTP_FROM || FROM_DEFAULT,
      status: 'failed',
      error: err.message?.slice(0, 500),
      htmlSnapshot: html,
      context: context || {},
      triggeredBy: triggeredBy || 'system'
    });
    logger.error('[SubscriptionEmail] Send failed', { type, toEmail, error: err.message });
    return { ok: false, status: 'failed', logId: log._id };
  }
};

// ─── Email types ─────────────────────────────────────────────────────

/**
 * #1 — Subscription assigned by admin.
 * Posiela sa po admin akcii ktorá zmenila `subscription.plan` alebo
 * `subscription.paidUntil`. Ak je to first-time upgrade na paid plan a
 * welcomePaidSentAt je null, posielame namiesto toho welcome_pro (richer).
 */
const sendSubscriptionAssigned = async ({ user, oldPlan, triggeredBy }) => {
  const newPlan = user.subscription?.plan || 'free';
  const isFirstPaid = oldPlan === 'free' && (newPlan === 'team' || newPlan === 'pro')
    && !user.subscription?.notifications?.welcomePaidSentAt;
  if (isFirstPaid) {
    return sendWelcomePaid({ user, triggeredBy });
  }

  const subject = `Váš plán bol aktualizovaný — ${PLAN_LABELS[newPlan] || newPlan}`;
  const paidUntil = user.subscription?.paidUntil ? formatDateSk(user.subscription.paidUntil) : null;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">
      administrátor PrplCRM práve aktualizoval váš účet. Aktuálny stav:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;width:100%;">
      <tr>
        <td style="padding:10px 14px;background:#f5f3ff;border-left:3px solid #8B5CF6;font-size:14px;color:#333;">
          <strong>Plán:</strong> ${PLAN_LABELS[newPlan] || newPlan}
        </td>
      </tr>
      ${paidUntil ? `<tr><td style="padding:10px 14px;background:#f9fafb;font-size:14px;color:#555;">
        <strong>Platnosť do:</strong> ${paidUntil}
      </td></tr>` : ''}
    </table>
    <p style="font-size:14px;color:#555;margin:0 0 16px;line-height:1.5;">
      Plán Pro odomyká neobmedzené kontakty, podúlohy do ľubovoľnej hĺbky, tímové pracovné prostredia a synchronizáciu s Google Calendar/Tasks.
    </p>
    ${ctaButton('Otvoriť CRM', APP_URL())}
    <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
      Akúkoľvek otázku ohľadom predplatného nám napíšte na
      <a href="mailto:support@prplcrm.eu" style="color:#8B5CF6;">support@prplcrm.eu</a>.
    </p>`;

  return sendAndLog({
    user,
    toEmail: user.email,
    type: 'subscription_assigned',
    subject,
    html: wrapEmail({ headerSubtitle: 'Aktualizácia plánu', bodyHtml }),
    context: {
      plan: newPlan,
      paidUntil: user.subscription?.paidUntil || null
    },
    triggeredBy: triggeredBy || 'system'
  });
};

/**
 * #2 — Discount assigned by admin.
 * 4 podtypy podľa user.subscription.discount.type:
 *  - percentage: "Dostali ste X% zľavu na Pro"
 *  - fixed: "Dostali ste zľavu X€"
 *  - freeMonths: "Dostali ste X mesiacov zdarma"
 *  - planUpgrade: "Bol vám pridelený plán X do dátumu Y"
 */
const sendDiscountAssigned = async ({ user, triggeredBy }) => {
  const d = user.subscription?.discount;
  if (!d?.type) return { ok: false, status: 'skipped_no_smtp', reason: 'no discount' };

  let subject = 'Špeciálna ponuka pre váš účet';
  let headline = '';
  let detailRow = '';

  if (d.type === 'percentage') {
    subject = `Dostali ste zľavu ${d.value}% na PrplCRM`;
    headline = `<strong>${d.value}% zľava</strong> na predplatné PrplCRM`;
    detailRow = `Stačí pri pokladni použiť promo kód v sekcii Predplatné.`;
  } else if (d.type === 'fixed') {
    subject = `Dostali ste zľavu ${d.value}€ na PrplCRM`;
    headline = `<strong>${d.value}€ zľava</strong> na predplatné PrplCRM`;
    detailRow = `Zľava sa automaticky uplatní pri ďalšej platbe.`;
  } else if (d.type === 'freeMonths') {
    subject = `${d.value} ${d.value === 1 ? 'mesiac' : 'mesiacov'} predplatného zdarma`;
    headline = `<strong>${d.value} ${d.value === 1 ? 'mesiac' : 'mesiacov'} zdarma</strong> na vašom účte`;
    detailRow = `Platnosť účtu sme predĺžili — môžete pokračovať bez prerušenia.`;
  } else if (d.type === 'planUpgrade') {
    subject = `Aktivovali sme vám plán ${PLAN_LABELS[d.targetPlan] || d.targetPlan}`;
    headline = `Plán <strong>${PLAN_LABELS[d.targetPlan] || d.targetPlan}</strong> aktivovaný na vašom účte`;
    detailRow = d.expiresAt
      ? `Platnosť do <strong>${formatDateSk(d.expiresAt)}</strong>. Po skončení sa účet vráti na Free, pokiaľ medzitým neaktivujete predplatné.`
      : `Bez časového obmedzenia.`;
  }

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">${headline} 🎉</p>
    <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.5;">${detailRow}</p>
    ${d.reason ? `<p style="font-size:13px;color:#666;margin:0 0 20px;padding:10px 14px;background:#f9fafb;border-left:3px solid #8B5CF6;line-height:1.5;"><em>${d.reason}</em></p>` : ''}
    ${ctaButton('Otvoriť CRM', APP_URL())}
    <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
      Otázky? Píšte na <a href="mailto:support@prplcrm.eu" style="color:#8B5CF6;">support@prplcrm.eu</a>.
    </p>`;

  return sendAndLog({
    user,
    toEmail: user.email,
    type: 'discount_assigned',
    subject,
    html: wrapEmail({ headerSubtitle: 'Špeciálna ponuka', bodyHtml }),
    context: {
      plan: user.subscription?.plan,
      paidUntil: user.subscription?.paidUntil || null,
      discountType: d.type,
      discountValue: d.value
    },
    triggeredBy: triggeredBy || 'system'
  });
};

/**
 * #3 — Welcome to Pro/Team. Jednorazový mail pri PRVOM upgrade na paid.
 * Po odoslaní nastavíme welcomePaidSentAt aby sa už nikdy neopakoval.
 */
const sendWelcomePaid = async ({ user, triggeredBy }) => {
  const plan = user.subscription?.plan || 'pro';
  // Subject bez emoji — emoji v subjecte je negatívny signal pre Yahoo
  // (typický pattern marketing spamu). Stačí emoji v body.
  const subject = `Vitajte v PrplCRM ${PLAN_LABELS[plan] || plan}`;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      gratulujeme — práve sa vám aktivoval plán <strong>${PLAN_LABELS[plan]}</strong>! Tu je čo máte navyše:
    </p>
    <ul style="font-size:14px;color:#444;margin:0 0 24px;padding-left:20px;line-height:1.7;">
      <li><strong>Neobmedzené kontakty a projekty</strong> — žiadne 5/10 limity</li>
      <li><strong>Podúlohy do ľubovoľnej hĺbky</strong> — nested štruktúra úloh</li>
      <li><strong>Synchronizácia s Google Calendar a Tasks</strong> — obojsmerná, real-time</li>
      <li><strong>Tímové pracovné prostredia</strong> — pozvite kolegov, prideľte role</li>
      <li><strong>Export do Excelu</strong> — všetky dáta v jednom kliku</li>
      <li><strong>Prioritná podpora</strong> — odpovedáme do 24 h</li>
    </ul>
    ${ctaButton('Otvoriť CRM', APP_URL())}
    <p style="font-size:13px;color:#666;margin:24px 0 0;line-height:1.5;">
      Tip: prepojte si Google účet v profile → <em>Synchronizácia kalendára</em>. Vaše projekty s termínmi sa automaticky prejavia v Google Calendar.
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
      Ak by ste potrebovali pomoc, napíšte nám na <a href="mailto:support@prplcrm.eu" style="color:#8B5CF6;">support@prplcrm.eu</a>.
    </p>`;

  const result = await sendAndLog({
    user,
    toEmail: user.email,
    type: 'welcome_pro',
    subject,
    html: wrapEmail({ headerSubtitle: `Vitajte v ${PLAN_LABELS[plan]}`, bodyHtml }),
    context: { plan, paidUntil: user.subscription?.paidUntil || null },
    triggeredBy: triggeredBy || 'system'
  });

  if (result.ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'subscription.notifications.welcomePaidSentAt': new Date() } }
    );
  }
  return result;
};

/**
 * #4 — Reminder T-7 days before paidUntil expiration.
 * Marketing — gated by preferences.marketingEmails. Kontextuálne čísla
 * z účtu zvyšujú konverziu (loss aversion: "stratíte to čo používate").
 */
const sendReminderT7 = async ({ user, accountStats, triggeredBy }) => {
  const plan = user.subscription?.plan || 'pro';
  const expires = formatDateSk(user.subscription?.paidUntil);
  const promo = PROMO.KEEP20;
  const subject = `Plán ${PLAN_LABELS[plan]} vyprší o 7 dní`;

  const statsBlock = accountStats ? `
    <p style="font-size:14px;color:#555;margin:0 0 12px;line-height:1.5;">Za posledný mesiac ste cez PrplCRM:</p>
    <ul style="font-size:14px;color:#444;margin:0 0 20px;padding-left:20px;line-height:1.7;">
      ${accountStats.contactCount > 0 ? `<li>spravovali <strong>${accountStats.contactCount}</strong> kontaktov</li>` : ''}
      ${accountStats.taskCount > 0 ? `<li>vytvorili <strong>${accountStats.taskCount}</strong> úloh</li>` : ''}
      ${accountStats.workspaceCount > 1 ? `<li>používali <strong>${accountStats.workspaceCount}</strong> pracovných prostredí</li>` : ''}
    </ul>
    <p style="font-size:14px;color:#555;margin:0 0 16px;line-height:1.5;">
      Po expirácii sa tieto funkcie obmedzia (Free plán = 5 kontaktov, 10 úloh).
    </p>` : '';

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">
      váš plán <strong>${PLAN_LABELS[plan]}</strong> vyprší <strong>${expires}</strong> — to je o <strong>7 dní</strong>.
    </p>
    ${statsBlock}
    <div style="margin:0 0 20px;padding:16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
      <p style="font-size:14px;color:#1f2937;margin:0 0 6px;font-weight:600;">Ponuka pri predĺžení</p>
      <p style="font-size:14px;color:#555;margin:0 0 4px;">20% zľava na predplatné platná 7 dní.</p>
      <p style="font-size:13px;color:#555;margin:0;">Promo kód: <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:14px;color:#6D28D9;border:1px solid #e5e7eb;">${promo}</code></p>
    </div>
    ${ctaButton('Predĺžiť plán', `${SITE_URL()}/app?upgrade=1&promo=${promo}`)}
    <p style="font-size:12px;color:#999;margin:16px 0 0;line-height:1.5;">
      Ak nechcete plán predĺžiť, nemusíte robiť nič — váš účet sa automaticky vráti na bezplatný Free plán.
    </p>`;

  const result = await sendAndLog({
    user,
    toEmail: user.email,
    type: 'reminder_t7',
    subject,
    html: wrapEmail({
      headerSubtitle: 'Pripomienka — 7 dní do expirácie',
      bodyHtml,
      unsubscribeLink: buildUnsubscribeLink(user._id)
    }),
    context: {
      plan,
      paidUntil: user.subscription?.paidUntil || null,
      promoCode: promo
    },
    triggeredBy: triggeredBy || 'cron'
  });

  if (result.ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'subscription.notifications.t7ReminderSentAt': new Date() } }
    );
  }
  return result;
};

/**
 * #5 — Reminder T-1 (last chance, day before expiry). Higher discount + urgency.
 */
const sendReminderT1 = async ({ user, triggeredBy }) => {
  const plan = user.subscription?.plan || 'pro';
  const expires = formatDateSk(user.subscription?.paidUntil);
  const promo = PROMO.KEEP30;
  // Subject bez emoji a bez ALL CAPS / "POSLEDNÝ DEŇ" patternu —
  // tieto trigger-uju Yahoo a Gmail spam filter. Vecná formulácia
  // "vyprší zajtra" + zľava ako informácia.
  const subject = `Pripomienka: váš plán ${PLAN_LABELS[plan]} vyprší zajtra`;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">
      váš plán <strong>${PLAN_LABELS[plan]}</strong> vyprší <strong>zajtra (${expires})</strong>.
      Po expirácii sa účet automaticky vráti na <strong>Free</strong> a tieto funkcie sa obmedzia:
    </p>
    <ul style="font-size:14px;color:#444;margin:0 0 24px;padding-left:20px;line-height:1.7;">
      <li>obmedzenie na 5 kontaktov a 10 úloh na kontakt</li>
      <li>žiadny tímový workspace pre kolegov</li>
      <li>vypnutie synchronizácie s Google Calendar/Tasks</li>
    </ul>
    <div style="margin:0 0 20px;padding:16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
      <p style="font-size:14px;color:#1f2937;margin:0 0 6px;font-weight:600;">Ponuka pri predĺžení</p>
      <p style="font-size:14px;color:#555;margin:0 0 4px;">30% zľava ak predĺžite do konca platnosti.</p>
      <p style="font-size:13px;color:#555;margin:0;">Promo kód: <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:14px;color:#6D28D9;font-weight:600;border:1px solid #e5e7eb;">${promo}</code></p>
    </div>
    ${ctaButton('Predĺžiť plán', `${SITE_URL()}/app?upgrade=1&promo=${promo}`)}
    <p style="font-size:12px;color:#999;margin:16px 0 0;line-height:1.5;">
      Po expirácii vaše dáta zostanú bezpečne uložené, len sa obmedzia funkcie. Predplatné si môžete kedykoľvek aktivovať späť.
    </p>`;

  const result = await sendAndLog({
    user,
    toEmail: user.email,
    type: 'reminder_t1',
    subject,
    html: wrapEmail({
      headerSubtitle: 'Posledný deň predplatného',
      bodyHtml,
      unsubscribeLink: buildUnsubscribeLink(user._id)
    }),
    context: { plan, paidUntil: user.subscription?.paidUntil || null, promoCode: promo },
    triggeredBy: triggeredBy || 'cron'
  });

  if (result.ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'subscription.notifications.t1ReminderSentAt': new Date() } }
    );
  }
  return result;
};

/**
 * #6 — Plan expired (after auto-downgrade to free).
 * Volá sa hneď po `expireUserIfNeeded()` v planExpiration.js.
 * Transakčný (NIE marketing) — informuje o stave účtu.
 */
const sendExpired = async ({ user, previousPlan, triggeredBy }) => {
  const promo = PROMO.COMEBACK30;
  const subject = `Váš plán vypršal — účet prešiel na Free`;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      váš plán <strong>${PLAN_LABELS[previousPlan]}</strong> vypršal a účet sme automaticky prepli na <strong>Free</strong>. Vaše dáta zostali nedotknuté — iba sa obmedzili niektoré funkcie.
    </p>
    <p style="font-size:14px;color:#555;margin:0 0 12px;line-height:1.5;">Čo sa zmenilo:</p>
    <ul style="font-size:14px;color:#444;margin:0 0 24px;padding-left:20px;line-height:1.7;">
      <li>Limit 5 kontaktov a 10 úloh na kontakt</li>
      <li>Tímové funkcie sú zatiaľ pozastavené</li>
      <li>Google Calendar/Tasks synchronizácia bola vypnutá</li>
    </ul>
    <div style="margin:0 0 20px;padding:16px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
      <p style="font-size:14px;color:#1f2937;margin:0 0 6px;font-weight:600;">Ponuka pri obnovení</p>
      <p style="font-size:14px;color:#555;margin:0 0 4px;">30% zľava na ${PLAN_LABELS[previousPlan] || 'predplatné'}, platná 14 dní.</p>
      <p style="font-size:13px;color:#555;margin:0;">Promo kód: <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:14px;color:#6D28D9;font-weight:600;border:1px solid #e5e7eb;">${promo}</code></p>
    </div>
    ${ctaButton(`Aktivovať ${PLAN_LABELS[previousPlan] || 'plán'}`, `${SITE_URL()}/app?upgrade=1&promo=${promo}`)}
    <p style="font-size:12px;color:#999;margin:16px 0 0;line-height:1.5;">
      Ak ste účet zámerne nechali expirovať, môžete tento email ignorovať. Vaše Free konto funguje ďalej bez obmedzenia času.
    </p>`;

  const result = await sendAndLog({
    user,
    toEmail: user.email,
    type: 'expired',
    subject,
    html: wrapEmail({ headerSubtitle: 'Plán expiroval', bodyHtml }),
    context: { plan: 'free', promoCode: promo },
    triggeredBy: triggeredBy || 'system'
  });

  if (result.ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'subscription.notifications.expiredEmailSentAt': new Date() } }
    );
  }
  return result;
};

/**
 * #7 — Winback (T+14 days after expiration). Posledný marketing pokus.
 */
const sendWinback = async ({ user, triggeredBy }) => {
  const promo = PROMO.WINBACK50;
  // Subject — vecná formulácia, žiadne "POSLEDNÁ PONUKA / ZĽAVA / 48 h"
  // (silné spam triggery v Yahoo aj Gmail). 50% zľava sa spomenie v body.
  const subject = `Stále tu pre vás — ponuka na návrat do PrplCRM`;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      pred dvoma týždňami vám expiroval plán. Vaše dáta sú stále uložené — kontakty, projekty, úlohy aj synchronizácia s Google. Ak by ste sa chceli vrátiť, pripravili sme pre vás ponuku.
    </p>
    <div style="margin:0 0 24px;padding:18px;background:#f9fafb;border-radius:10px;border:1px solid #e5e7eb;">
      <p style="font-size:14px;color:#1f2937;margin:0 0 6px;font-weight:600;">Ponuka na obnovenie</p>
      <p style="font-size:14px;color:#555;margin:0 0 4px;">50% zľava na prvý mesiac PrplCRM Pro.</p>
      <p style="font-size:13px;color:#555;margin:0;">Promo kód: <code style="background:#fff;padding:2px 8px;border-radius:4px;font-size:14px;color:#6D28D9;font-weight:600;border:1px solid #e5e7eb;">${promo}</code></p>
    </div>
    <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.5;">
      Po prihlásení sa všetky funkcie aktivujú okamžite — žiadny export, žiadna migrácia.
    </p>
    ${ctaButton('Otvoriť PrplCRM', `${SITE_URL()}/app?upgrade=1&promo=${promo}`)}
    <p style="font-size:12px;color:#999;margin:16px 0 0;line-height:1.5;">
      Toto je posledný marketingový email od nás. Ďalej už takéto pripomienky neposielame, pokiaľ nezaregistrujete nový aktívny plán.
    </p>`;

  const result = await sendAndLog({
    user,
    toEmail: user.email,
    type: 'winback',
    subject,
    html: wrapEmail({
      headerSubtitle: 'Posledná ponuka',
      bodyHtml,
      unsubscribeLink: buildUnsubscribeLink(user._id)
    }),
    context: { plan: 'free', promoCode: promo },
    triggeredBy: triggeredBy || 'cron'
  });

  if (result.ok) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'subscription.notifications.winbackSentAt': new Date() } }
    );
  }
  return result;
};

/**
 * Reset all reminder timestamps when admin manually changes paidUntil.
 * Volá sa zo všetkých admin endpointov ktoré menia paidUntil — bez toho
 * by user nedostal T-7 reminder pre novo-predĺžený cyklus.
 */
const resetReminderFlags = async (userId) => {
  return User.updateOne(
    { _id: userId },
    {
      $set: {
        'subscription.notifications.t7ReminderSentAt': null,
        'subscription.notifications.t1ReminderSentAt': null,
        'subscription.notifications.expiredEmailSentAt': null,
        'subscription.notifications.winbackSentAt': null
      }
    }
  );
};

const verifyUnsubscribeToken = (token) => {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const expected = crypto.createHmac('sha256', secret).update(`${userId}.${ts}`).digest('hex').slice(0, 32);
    if (sig !== expected) return null;
    return userId;
  } catch (err) {
    return null;
  }
};

/**
 * One-off broadcast: launch oznam o mobilnej appke. Posielame všetkým
 * registrovaným userom (alebo filtrované — len aktívnym za posledných N dní).
 *
 * Copy je úmyselne neutrálny pre obidve platformy — Android live, iOS
 * čoskoro — aby iPhone userovia nevnímali ako spam ale ako pozitívnu
 * správu o tom že iOS verzia tiež príde.
 *
 * Volá sa raz, manuálne z admin panelu cez `/api/admin/email-broadcast/...`.
 * Na zopakovanie netreba — EmailLog cooldown nepúšťa pre marketing typ.
 */
const sendMobileAppLaunch = async ({ user, triggeredBy }) => {
  const subject = `Prpl CRM je teraz aj ako mobilná aplikácia`;
  const playStoreUrl = 'https://play.google.com/store/apps/details?id=eu.prplcrm.app';

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${user.username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      máme pre vás dobrú správu — Prpl CRM si od dnešného dňa môžete stiahnuť aj ako mobilnú aplikáciu.
    </p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;line-height:1.5;">
      Tu je rýchly prehľad:
    </p>
    <ul style="font-size:14px;color:#444;margin:0 0 24px;padding-left:20px;line-height:1.7;">
      <li><strong>Android verzia</strong> je k dispozícii na Google Play už dnes</li>
      <li><strong>iOS verzia</strong> prechádza posledným kolom Apple App Store review a bude dostupná v najbližších dňoch</li>
      <li>Prihlasujete sa do nej rovnakým účtom ako na webe — všetky vaše dáta sú okamžite tam</li>
    </ul>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${playStoreUrl}" style="display:inline-block;background:#8B5CF6;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Stiahnuť na Google Play
        </a>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#666;margin:0 0 16px;line-height:1.5;text-align:center;">
      <em>Pre iPhone používateľov</em> — App Store verzia príde v najbližších dňoch a oznámime vám to ihneď.
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="font-size:13px;color:#666;margin:0;line-height:1.5;">
      Web verzia funguje ďalej rovnako ako predtým — mobilná appka je doplnok pre situácie keď nie ste pri počítači. Vyskúšajte a dajte nám vedieť čo si myslíte.
    </p>
    <p style="font-size:12px;color:#999;margin:16px 0 0;line-height:1.5;">
      Otázky? Píšte nám na <a href="mailto:support@prplcrm.eu" style="color:#8B5CF6;">support@prplcrm.eu</a>.
    </p>`;

  return sendAndLog({
    user,
    toEmail: user.email,
    type: 'mobile_app_launch',
    subject,
    html: wrapEmail({ headerSubtitle: 'Mobilná aplikácia', bodyHtml }),
    context: { plan: user.subscription?.plan },
    triggeredBy: triggeredBy || 'admin-broadcast'
  });
};

module.exports = {
  initTransporter,
  sendSubscriptionAssigned,
  sendDiscountAssigned,
  sendWelcomePaid,
  sendReminderT7,
  sendReminderT1,
  sendExpired,
  sendWinback,
  sendMobileAppLaunch,
  resetReminderFlags,
  verifyUnsubscribeToken,
  PROMO,
  PLAN_LABELS,
  MARKETING_TYPES
};
