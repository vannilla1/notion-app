/**
 * Utility exports
 * Import from '@/utils' or '../utils'
 */

// Validators
export {
  EMAIL_REGEX,
  PHONE_REGEX,
  isValidEmail,
  isValidPhone,
  validateContactForm,
  validatePassword
} from './validators';

// Formatters
export {
  formatDate,
  formatDateTime,
  formatFileSize,
  formatRelativeTime,
  truncateText,
  formatNumber
} from './formatters';

// Constants
export {
  // Status enums
  CONTACT_STATUS,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_COLORS,
  TASK_STATUS,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  PRIORITY,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  USER_ROLE,
  USER_ROLE_LABELS,
  WORKSPACE_ROLE,
  WORKSPACE_ROLE_LABELS,
  // Helper functions
  getStatusLabel,
  getStatusColor,
  getTaskStatusLabel,
  getTaskStatusColor,
  getPriorityLabel,
  getPriorityColor,
  getUserRoleLabel,
  getWorkspaceRoleLabel,
  // Other constants
  PROFILE_COLORS,
  FILE_SIZE_LIMITS,
  ALLOWED_AVATAR_TYPES
} from './constants';
