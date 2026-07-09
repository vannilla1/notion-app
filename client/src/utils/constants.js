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

// Priority colors — zhodné s getPriorityColor() v Tasks.jsx / TaskList.jsx
// (zdroj pravdy pre vizuál priority badge-ov v projektovom UI). Nízka = green
// (relax / bez urgencie), Stredná = orange, Vysoká = red (urgent / eskalácia).
export const PRIORITY_COLORS = {
  low: '#10b981',     // green
  medium: '#f59e0b',  // orange
  high: '#ef4444'     // red
};

// Paleta farieb na označenie pracovných prostredí (workspace). Centrálne miesto
// pre WorkspaceSwitcher aj UserMenu (predtým dve nesúrodé kópie po 8 farieb).
export const WORKSPACE_COLORS = [
  '#6366F1', // indigo (default)
  '#3B82F6', // blue
  '#06B6D4', // cyan
  '#0EA5E9', // sky
  '#14B8A6', // teal
  '#10B981', // emerald
  '#22C55E', // green
  '#84CC16', // lime
  '#EAB308', // yellow
  '#F59E0B', // amber
  '#F97316', // orange
  '#EF4444', // red
  '#EC4899', // pink
  '#F43F5E', // rose
  '#D946EF', // fuchsia
  '#A855F7', // purple
  '#8B5CF6', // violet
  '#64748B'  // slate (neutral)
];

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

// Workspace roles — MUSIA sedieť s enumom v server/models/WorkspaceMember.js
export const WORKSPACE_ROLE = {
  OWNER: 'owner',
  MANAGER: 'manager',
  MEMBER: 'member'
};

// Workspace role labels (Slovak)
export const WORKSPACE_ROLE_LABELS = {
  owner: 'Vlastník',
  manager: 'Manažér',
  member: 'Člen'
};

// Cross-page custom events (dispatched z WorkspaceContext / AuthContext)
export const APP_EVENTS = {
  WORKSPACE_SWITCHED: 'workspace-switched',
  APP_RESUMED: 'app-resumed'
};

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
  AVATAR: 5 * 1024 * 1024,       // 5MB
  CONTACT_FILE: 10 * 1024 * 1024  // 10MB
};

// Allowed file types for avatars
export const ALLOWED_AVATAR_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];
