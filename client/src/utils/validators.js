/**
 * Shared validation utilities
 * Used across client components to validate user inputs
 */

// Email validation regex
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Phone validation regex - allows +, digits, spaces, and dashes
export const PHONE_REGEX = /^[+]?[0-9\s-]+$/;

/**
 * Validates an email address
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid
 */
export const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim());
};

/**
 * Validates a phone number
 * @param {string} phone - Phone number to validate
 * @returns {boolean} - True if valid
 */
export const isValidPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  // Allow empty phone numbers
  if (trimmed === '') return true;
  return PHONE_REGEX.test(trimmed);
};

/**
 * Validates contact form data
 * @param {object} data - Contact data object
 * @returns {object} - { isValid: boolean, errors: object }
 */
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

/**
 * Validates password strength
 * @param {string} password - Password to validate
 * @returns {object} - { isValid: boolean, message: string }
 */
export const validatePassword = (password) => {
  if (!password || password.length < 6) {
    return {
      isValid: false,
      message: 'Heslo musí mať aspoň 6 znakov'
    };
  }
  return { isValid: true, message: '' };
};
