// Email validation regex
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PHONE_REGEX = /^[+]?[0-9\s-]+$/;

export const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim());
};

export const isValidPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  // Allow empty phone numbers
  if (trimmed === '') return true;
  return PHONE_REGEX.test(trimmed);
};

export const validateContactForm = (data) => {
  const errors = {};

  // Name is required
  if (!data.name || data.name.trim() === '') {
    errors.name = 'Meno je povinné';
  }

  // Email validation (optional but must be valid if provided)
  if (data.email && !isValidEmail(data.email)) {
    errors.email = 'Neplatný formát emailu';
  }

  // Phone validation (optional but must be valid if provided)
  if (data.phone && !isValidPhone(data.phone)) {
    errors.phone = 'Neplatný formát telefónneho čísla';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors
  };
};

export const validatePassword = (password) => {
  if (!password || password.length < 6) {
    return {
      isValid: false,
      message: 'Heslo musí mať aspoň 6 znakov'
    };
  }
  return { isValid: true, message: '' };
};
