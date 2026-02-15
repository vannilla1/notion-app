import api from './api';

// Get all workspaces user is member of
export const getWorkspaces = async () => {
  const response = await api.get('/api/workspaces');
  return response.data;
};

// Get current workspace details
export const getCurrentWorkspace = async () => {
  const response = await api.get('/api/workspaces/current');
  return response.data;
};

// Create new workspace
export const createWorkspace = async (data) => {
  const response = await api.post('/api/workspaces', data);
  return response.data;
};

// Join workspace by invite code
export const joinWorkspace = async (inviteCode) => {
  const response = await api.post('/api/workspaces/join', { inviteCode });
  return response.data;
};

// Switch to different workspace
export const switchWorkspace = async (workspaceId) => {
  const response = await api.post(`/api/workspaces/switch/${workspaceId}`);
  return response.data;
};

// Update current workspace
export const updateWorkspace = async (data) => {
  const response = await api.put('/api/workspaces/current', data);
  return response.data;
};

// Regenerate invite code
export const regenerateInviteCode = async () => {
  const response = await api.post('/api/workspaces/current/regenerate-invite');
  return response.data;
};

// Get workspace members
export const getWorkspaceMembers = async () => {
  const response = await api.get('/api/workspaces/current/members');
  return response.data;
};

// Update member role
export const updateMemberRole = async (memberId, role) => {
  const response = await api.put(`/api/workspaces/current/members/${memberId}/role`, { role });
  return response.data;
};

// Remove member
export const removeMember = async (memberId) => {
  const response = await api.delete(`/api/workspaces/current/members/${memberId}`);
  return response.data;
};

// Leave workspace
export const leaveWorkspace = async () => {
  const response = await api.post('/api/workspaces/current/leave');
  return response.data;
};

// Transfer ownership
export const transferOwnership = async (newOwnerId) => {
  const response = await api.post(`/api/workspaces/current/transfer-ownership/${newOwnerId}`);
  return response.data;
};

// Delete workspace
export const deleteWorkspace = async () => {
  const response = await api.delete('/api/workspaces/current');
  return response.data;
};
