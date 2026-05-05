const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Centralizovaný HTML→text stripper pre multipart/alternative. Yahoo a Gmail
// penalizujú HTML-only maily ako podozrivé bulk-marketing pattern, preto
// každé volanie sendMail by malo mať aj `text:` alternatívu.
const htmlToText = (html) => {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const cleanText = text.replace(/<[^>]+>/g, '').trim();
      if (!cleanText || cleanText === href) return href;
      return `${cleanText} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|tr|div|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
};

let transporter = null;

const initializeEmail = () => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_PORT === '465'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    logger.info('[AdminEmail] Email service initialized');
    return true;
  }
  logger.warn('[AdminEmail] SMTP not configured, email notifications disabled');
  return false;
};

const sendAdminEmail = async (subject, html) => {
  if (!transporter) return;
  const adminEmail = process.env.ADMIN_EMAIL || 'support@prplcrm.eu';
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"PrplCRM System" <hello@prplcrm.eu>',
      to: adminEmail,
      subject: `[PrplCRM Admin] ${subject}`,
      html
    });
  } catch (err) {
    logger.error('[AdminEmail] Failed to send', { error: err.message, subject });
  }
};

const notifyNewRegistration = (user) => {
  sendAdminEmail('Nová registrácia',
    `<p>Nový používateľ sa zaregistroval:</p>
    <ul><li><strong>${user.username}</strong></li><li>${user.email}</li>
    <li>Dátum: ${new Date().toLocaleString('sk-SK')}</li></ul>`
  );
};

const notifyError = (context, error) => {
  sendAdminEmail(`Chyba: ${context}`,
    `<p>Nastala chyba v systéme:</p><pre>${context}\n${error}</pre>
    <p>Čas: ${new Date().toLocaleString('sk-SK')}</p>`
  );
};

/**
 * Send workspace invitation email to the invitee
 */
const sendInvitationEmail = async ({ toEmail, inviterName, workspaceName, role, inviteLink, expiresAt }) => {
  if (!transporter) {
    logger.warn('[AdminEmail] Cannot send invitation — SMTP not configured');
    return false;
  }

  const roleLabel = role === 'manager' ? 'Manažér' : 'Člen';
  const expiresFormatted = expiresAt ? new Date(expiresAt).toLocaleDateString('sk-SK') : '7 dní';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#8B5CF6,#6D28D9);padding:32px 28px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">PrplCRM</h1>
          <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Pozvánka do tímu</p>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 28px;">
          <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj,</p>
          <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
            <strong>${inviterName}</strong> vás pozýva do prostredia <strong>${workspaceName}</strong> v aplikácii PrplCRM ako <strong>${roleLabel}</strong>.
          </p>
          <!-- CTA Button -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
            <tr><td align="center">
              <a href="${inviteLink}" style="display:inline-block;background:#8B5CF6;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
                Prijať pozvánku
              </a>
            </td></tr>
          </table>
          <p style="font-size:13px;color:#666;margin:20px 0 0;line-height:1.5;">
            Ak ešte nemáte konto v PrplCRM, po kliknutí sa budete môcť zaregistrovať a automaticky sa pridáte do prostredia.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
            Platnosť pozvánky: do <strong>${expiresFormatted}</strong><br/>
            Ak ste túto pozvánku neočakávali, môžete ju ignorovať.
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:16px 28px;text-align:center;">
          <p style="font-size:11px;color:#aaa;margin:0;">
            PrplCRM · <a href="https://prplcrm.eu" style="color:#8B5CF6;text-decoration:none;">prplcrm.eu</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"PrplCRM" <hello@prplcrm.eu>',
      replyTo: process.env.SMTP_REPLY_TO || 'support@prplcrm.eu',
      text: htmlToText(html),
      to: toEmail,
      subject: `Pozvánka do prostredia ${workspaceName} — PrplCRM`,
      html
    });
    logger.info('[AdminEmail] Invitation email sent', { toEmail, workspaceName });
    return true;
  } catch (err) {
    logger.error('[AdminEmail] Failed to send invitation email', { error: err.message, toEmail });
    return false;
  }
};

/**
 * Shared HTML shell (PrplCRM fialový header + biela karta + footer).
 * Každý email používa rovnaký layout pre brand konzistenciu.
 */
const wrapEmail = ({ headerTitle, headerSubtitle, bodyHtml }) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#8B5CF6,#6D28D9);padding:32px 28px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">PrplCRM</h1>
          <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">${headerSubtitle}</p>
        </td></tr>
        <tr><td style="padding:32px 28px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 28px;text-align:center;">
          <p style="font-size:11px;color:#aaa;margin:0;">
            PrplCRM · <a href="https://prplcrm.eu" style="color:#8B5CF6;text-decoration:none;">prplcrm.eu</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

/**
 * Welcome email po registrácii — priateľský tón + quick-start tipy.
 */
const sendWelcomeEmail = async ({ toEmail, username }) => {
  if (!transporter) {
    logger.warn('[AdminEmail] Cannot send welcome email — SMTP not configured');
    return false;
  }

  const appUrl = `${process.env.CLIENT_URL || 'https://prplcrm.eu'}/app`;

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${username}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      ďakujeme, že ste si vytvorili účet v <strong>PrplCRM</strong>. Sme radi, že vás tu máme! 🎉
    </p>
    <p style="font-size:15px;color:#333;margin:0 0 12px;line-height:1.5;">Pre rýchly štart vyskúšajte:</p>
    <ul style="font-size:14px;color:#444;margin:0 0 24px;padding-left:20px;line-height:1.7;">
      <li><strong>Vytvorte prvý kontakt</strong> — v sekcii <em>Kontakty</em> kliknite na <em>Nový kontakt</em></li>
      <li><strong>Pridajte projekt alebo úlohu</strong> — v sekcii <em>Projekty</em> priraďte termín a prioritu</li>
      <li><strong>Pozvite kolegov do prostredia</strong> — v menu profilu → <em>Členovia prostredia</em></li>
    </ul>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${appUrl}" style="display:inline-block;background:#8B5CF6;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Otvoriť CRM
        </a>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#666;margin:20px 0 0;line-height:1.5;">
      Ak by ste potrebovali pomoc, napíšte nám na <a href="mailto:support@prplcrm.eu" style="color:#8B5CF6;">support@prplcrm.eu</a>.
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
      Veľa úspechov s PrplCRM!<br/>
      <em>Tím PrplCRM</em>
    </p>
  `;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"PrplCRM" <hello@prplcrm.eu>',
      replyTo: process.env.SMTP_REPLY_TO || 'support@prplcrm.eu',
      text: htmlToText(html),
      to: toEmail,
      subject: 'Vitajte v PrplCRM 👋',
      html: wrapEmail({ headerSubtitle: 'Vitajte na palube', bodyHtml })
    });
    logger.info('[AdminEmail] Welcome email sent', { toEmail });
    return true;
  } catch (err) {
    logger.error('[AdminEmail] Failed to send welcome email', { error: err.message, toEmail });
    return false;
  }
};

/**
 * Password reset email — obsahuje link s plain tokenom v query stringu.
 * Token sa v DB ukladá ako SHA-256 hash (viď routes/auth.js).
 */
const sendPasswordResetEmail = async ({ toEmail, username, resetLink }) => {
  if (!transporter) {
    logger.warn('[AdminEmail] Cannot send reset email — SMTP not configured');
    return false;
  }

  const bodyHtml = `
    <p style="font-size:15px;color:#333;margin:0 0 16px;line-height:1.5;">Ahoj <strong>${username || ''}</strong>,</p>
    <p style="font-size:15px;color:#333;margin:0 0 20px;line-height:1.5;">
      dostali sme žiadosť o obnovenie hesla pre váš účet v <strong>PrplCRM</strong>.
      Ak ste žiadosť neposielali vy, tento email môžete ignorovať — vaše heslo sa nezmení.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${resetLink}" style="display:inline-block;background:#8B5CF6;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
          Nastaviť nové heslo
        </a>
      </td></tr>
    </table>
    <p style="font-size:13px;color:#666;margin:0 0 12px;line-height:1.5;">
      Prípadne skopírujte a vložte do prehliadača tento odkaz:
    </p>
    <p style="font-size:12px;color:#6366f1;word-break:break-all;margin:0 0 20px;">
      ${resetLink}
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
      Odkaz je platný <strong>1 hodinu</strong> a použiť ho môžete <strong>len raz</strong>.
    </p>
  `;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"PrplCRM" <hello@prplcrm.eu>',
      replyTo: process.env.SMTP_REPLY_TO || 'support@prplcrm.eu',
      text: htmlToText(html),
      to: toEmail,
      subject: 'Obnovenie hesla — PrplCRM',
      html: wrapEmail({ headerSubtitle: 'Obnovenie hesla', bodyHtml })
    });
    logger.info('[AdminEmail] Password reset email sent', { toEmail });
    return true;
  } catch (err) {
    logger.error('[AdminEmail] Failed to send reset email', { error: err.message, toEmail });
    return false;
  }
};

module.exports = {
  initializeEmail,
  sendAdminEmail,
  notifyNewRegistration,
  notifyError,
  sendInvitationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail
};
