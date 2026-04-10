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
      from: process.env.SMTP_FROM || '"PrplCRM System" <noreply@prplcrm.eu>',
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

module.exports = { initializeEmail, sendAdminEmail, notifyNewRegistration, notifyError };
