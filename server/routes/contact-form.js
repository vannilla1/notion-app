const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// Rate limit: max 5 submissions per 15 minutes per IP
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: 'Príliš veľa správ. Skúste to znova neskôr.' }
});

const transporter = nodemailer.createTransport({
  host: 'smtp.hostcreators.sk',
  port: 465,
  secure: true,
  auth: {
    user: 'support@prplcrm.eu',
    pass: process.env.SMTP_PASSWORD
  }
});

router.post('/', contactLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Vyplňte všetky povinné polia.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Neplatný formát emailu.' });
    }

    if (message.length > 5000) {
      return res.status(400).json({ message: 'Správa je príliš dlhá (max 5000 znakov).' });
    }

    await transporter.sendMail({
      from: '"Prpl CRM Kontakt" <support@prplcrm.eu>',
      to: 'support@prplcrm.eu',
      replyTo: email,
      subject: `Kontaktný formulár: ${name}`,
      html: `
        <h3>Nová správa z kontaktného formulára</h3>
        <p><strong>Meno:</strong> ${name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        <p><strong>Email:</strong> ${email.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        <p><strong>Správa:</strong></p>
        <p>${message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
        <hr>
        <p style="color: #888; font-size: 12px;">Odoslané z prplcrm.eu kontaktného formulára</p>
      `
    });

    res.json({ message: 'Správa bola úspešne odoslaná.' });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ message: 'Nepodarilo sa odoslať správu. Skúste to znova.' });
  }
});

module.exports = router;
