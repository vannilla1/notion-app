/**
 * Shared constants for status, priority, and other enums
 * Centralized to avoid duplication across components
 */

// Contact statuses
export const CONTACT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  LEAD: 'lead',
  CUSTOMER: 'customer'
};

// Contact status labels (Slovak)
export const CONTACT_STATUS_LABELS = {
  active: 'Aktívny',
  inactive: 'Neaktívny',
  lead: 'Potenciálny',
  customer: 'Zákazník'
};

// Contact status colors
export const CONTACT_STATUS_COLORS = {
  active: '#10b981',    // green
  inactive: '#6b7280',  // gray
  lead: '#f59e0b',      // yellow/orange
  customer: '#3b82f6'   // blue
};

// Task/Priority statuses
export const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed'
};

// Task status labels (Slovak)
export const TASK_STATUS_LABELS = {
  pending: 'Čakajúca',
  in_progress: 'Prebieha',
  completed: 'Dokončená'
};

// Task status colors
export const TASK_STATUS_COLORS = {
  pending: '#f59e0b',      // yellow/orange
  in_progress: '#3b82f6',  // blue
  completed: '#10b981'     // green
};

// Priority levels
export const PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

// Priority labels (Slovak)
export const PRIORITY_LABELS = {
  low: 'Nízka',
  medium: 'Stredná',
  high: 'Vysoká'
};

// Priority colors
export const PRIORITY_COLORS = {
  low: '#6b7280',     // gray
  medium: '#f59e0b',  // yellow/orange
  high: '#ef4444'     // red
};

// User roles
export const USER_ROLE = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  USER: 'user'
};

// User role labels (Slovak)
export const USER_ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manažér',
  user: 'Používateľ'
};

// Workspace roles
export const WORKSPACE_ROLE = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member'
};

// Workspace role labels (Slovak)
export const WORKSPACE_ROLE_LABELS = {
  owner: 'Vlastník',
  admin: 'Admin',
  member: 'Člen'
};

/**
 * Helper functions to get labels and colors
 */

export const getStatusLabel = (status) => {
  return CONTACT_STATUS_LABELS[status] || status || '-';
};

export const getStatusColor = (status) => {
  return CONTACT_STATUS_COLORS[status] || '#6b7280';
};

export const getTaskStatusLabel = (status) => {
  return TASK_STATUS_LABELS[status] || status || '-';
};

export const getTaskStatusColor = (status) => {
  return TASK_STATUS_COLORS[status] || '#6b7280';
};

export const getPriorityLabel = (priority) => {
  return PRIORITY_LABELS[priority] || priority || '-';
};

export const getPriorityColor = (priority) => {
  return PRIORITY_COLORS[priority] || '#6b7280';
};

export const getUserRoleLabel = (role) => {
  return USER_ROLE_LABELS[role] || role || '-';
};

export const getWorkspaceRoleLabel = (role) => {
  return WORKSPACE_ROLE_LABELS[role] || role || '-';
};

// Profile color options
export const PROFILE_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'
];

// File size limits (in bytes)
export const FILE_SIZE_LIMITS = {
  AVATAR: 5 * 1024 * 1024,      // 5MB
  CONTACT_FILE: 5 * 1024 * 1024  // 5MB
};

// Allowed file types for avatars
export const ALLOWED_AVATAR_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];
