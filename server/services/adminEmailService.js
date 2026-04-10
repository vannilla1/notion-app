const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

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

module.exports = { initializeEmail, sendAdminEmail, notifyNewRegistration, notifyError, sendInvitationEmail };
