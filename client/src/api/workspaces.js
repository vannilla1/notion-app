import api from './api';

export const getWorkspaces = async () => {
  const response = await api.get('/api/workspaces');
  return response.data;
};

export const getCurrentWorkspace = async () => {
  const response = await api.get('/api/workspaces/current');
  return response.data;
};

export const createWorkspace = async (data) => {
  const response = await api.post('/api/workspaces', data);
  return response.data;
};

export const joinWorkspace = async (inviteCode) => {
  const response = await api.post('/api/workspaces/join', { inviteCode });
  return response.data;
};

export const switchWorkspace = async (workspaceId) => {
  const response = await api.post(`/api/workspaces/switch/${workspaceId}`);
  return response.data;
};

export const updateWorkspace = async (data) => {
  const response = await api.put('/api/workspaces/current', data);
  return response.data;
};

export const regenerateInviteCode = async () => {
  const response = await api.post('/api/workspaces/current/regenerate-invite');
  return response.data;
};

export const getWorkspaceMembers = async () => {
  const response = await api.get('/api/workspaces/current/members');
  return response.data;
};

export const updateMemberRole = async (memberId, role) => {
  const response = await api.put(`/api/workspaces/current/members/${memberId}/role`, { role });
  return response.data;
};

export const removeMember = async (memberId) => {
  const response = await api.delete(`/api/workspaces/current/members/${memberId}`);
  return response.data;
};

export const leaveWorkspace = async () => {
  const response = await api.post('/api/workspaces/current/leave');
  return response.data;
};

export const transferOwnership = async (newOwnerId) => {
  const response = await api.post(`/api/workspaces/current/transfer-ownership/${newOwnerId}`);
  return response.data;
};

export const deleteWorkspace = async () => {
  const response = await api.delete('/api/workspaces/current');
  return response.data;
};

export const sendInvitation = async (email, role) => {
  const response = await api.post('/api/workspaces/current/invitations', { email, role });
  return response.data;
};

export const getInvitations = async () => {
  const response = await api.get('/api/workspaces/current/invitations');
  return response.data;
};

export const cancelInvitation = async (invitationId) => {
  const response = await api.delete(`/api/workspaces/current/invitations/${invitationId}`);
  return response.data;
};

export const getInvitationByToken = async (token) => {
  const response = await api.get(`/api/workspaces/invitation/${token}`);
  return response.data;
};

export const acceptInvitation = async (token) => {
  const response = await api.post(`/api/workspaces/invitation/${token}/accept`);
  return response.data;
};
