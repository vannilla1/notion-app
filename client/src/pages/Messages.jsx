import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import api from '@/api/api';
import { downloadBlob } from '../utils/fileDownload';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from '../components/UserMenu';
import HelpGuide from '../components/HelpGuide';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';
import { useWorkspace } from '../context/WorkspaceContext';

const messagesHelpTips = [
  { icon: '📨', title: 'Správy', description: 'Posielajte interné správy členom tímu — žiadosti o schválenie, návrhy, informácie alebo žiadosti.' },
  { icon: '🟡', title: 'Typy odkazov', description: 'Schválenie (žltá) — vyžaduje rozhodnutie. Informácia (modrá) — len na prečítanie. Žiadosť (oranžová) — prosba o akciu. Návrh (zelená) — diskusia.' },
  { icon: '✅', title: 'Akcie príjemcu', description: 'Prijaté odkazy môžete schváliť, zamietnuť alebo komentovať. Komentované správy je možné následne ešte schváliť alebo zamietnuť.' },
  { icon: '📎', title: 'Prílohy', description: 'Ku každému odkazu môžete priložiť viacero súborov (max. 10 MB na súbor) — dokumenty, obrázky, PDF a ďalšie formáty.' },
  { icon: '🔗', title: 'Prepojenia', description: 'Odkaz môžete prepojiť s konkrétnym kontaktom alebo projektom. Prepojené správy sa zobrazujú aj v detaile kontaktu alebo projektu.' },
  { icon: '🗑️', title: 'Správa odkazov', description: 'Vlastník a manažér workspace môžu vymazať akúkoľvek správu. Odosielateľ môže upraviť alebo vymazať svoje vlastné správy.' }
];

const typeConfig = {
  approval: { label: 'Schválenie', icon: '🟡', color: '#F59E0B' },
  info: { label: 'Informácia', icon: '🔵', color: '#3B82F6' },
  request: { label: 'Žiadosť', icon: '🟠', color: '#F97316' },
  proposal: { label: 'Návrh', icon: '🟢', color: '#10B981' },
  poll: { label: 'Anketa', icon: '📊', color: '#EC4899' }
};

const statusConfig = {
  pending: { label: 'Čaká', icon: '🕐', color: '#F59E0B' },
  approved: { label: 'Schválené', icon: '✅', color: '#10B981' },
  rejected: { label: 'Zamietnuté', icon: '❌', color: '#EF4444' },
  commented: { label: 'Komentované', icon: '💬', color: '#6366F1' }
};

function Messages() {
  const { user, logout, updateUser } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { socket, isConnected } = useSocket();

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('received'); // received | sent
  const [statusFilter, setStatusFilter] = useState('all');
  const [pendingCount, setPendingCount] = useState(0);

  // New message form
  const [showForm, setShowForm] = useState(false);
  const [users, setUsers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState({
    toUserId: '', type: 'approval', subject: '', description: '',
    linkedType: '', linkedId: '', linkedName: '', dueDate: '',
    pollOptions: ['', ''], pollMultipleChoice: false
  });
  const [attachment, setAttachment] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Detail view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [commentAttachment, setCommentAttachment] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [editing, setEditing] = useState(false);

  // File attachments
  const [uploadingFile, setUploadingFile] = useState(false);
  const msgFileInputRef = useRef(null);
  const [activeFileMessageId, setActiveFileMessageId] = useState(null);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Stats for sidebar (memoized)
  const receivedMessages = messages;
  const messageStats = useMemo(() => ({
    pending: messages.filter(m => m.status === 'pending'),
    approved: messages.filter(m => m.status === 'approved'),
    rejected: messages.filter(m => m.status === 'rejected'),
    commented: messages.filter(m => m.status === 'commented'),
  }), [messages]);
  const { pending: pendingMessages, approved: approvedMessages, rejected: rejectedMessages, commented: commentedMessages } = messageStats;

  useEffect(() => { setLoading(true); fetchMessages(); fetchPendingCount(); }, [tab, statusFilter]);

  // Refresh when app returns from background (iOS / tab switch)
  useEffect(() => {
    const handleResume = () => { fetchMessages(); fetchPendingCount(); };
    window.addEventListener('app-resumed', handleResume);
    return () => window.removeEventListener('app-resumed', handleResume);
  }, [tab, statusFilter]);

  useEffect(() => {
    if (showForm) { fetchUsers(); fetchContactsAndTasks(); }
  }, [showForm]);

  // Socket events — debounced to coalesce rapid updates
  const msgFetchTimerRef = useRef(null);
  useEffect(() => {
    if (!socket || !isConnected) return;
    const refresh = () => {
      if (msgFetchTimerRef.current) clearTimeout(msgFetchTimerRef.current);
      msgFetchTimerRef.current = setTimeout(() => { fetchMessages(); fetchPendingCount(); }, 300);
    };
    socket.on('message-created', refresh);
    socket.on('message-updated', refresh);
    socket.on('message-deleted', refresh);
    return () => {
      socket.off('message-created', refresh);
      socket.off('message-updated', refresh);
      socket.off('message-deleted', refresh);
      if (msgFetchTimerRef.current) clearTimeout(msgFetchTimerRef.current);
    };
  }, [socket, isConnected, tab, statusFilter]);

  // Deep link tab (only on URL change, not on messages change)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tabParam = params.get('tab');
    if (tabParam === 'received' || tabParam === 'sent') {
      setTab(tabParam);
    }
  }, [location.search]);

  // Deep link highlight — fetch message by ID, switch to correct tab, select it
  const lastMsgHighlightRef = useRef(null);
  const highlightMessage = async (messageId) => {
    try {
      const res = await api.get(`/api/messages/${messageId}`);
      const msg = res.data;
      if (!msg) return;

      // Determine correct tab: if user is recipient → received, if sender → sent
      const userId = user?.id || user?._id;
      const isRecipient = msg.toUserId?.toString() === userId?.toString() ||
        msg.toUserId?._id?.toString() === userId?.toString();
      const correctTab = isRecipient ? 'received' : 'sent';

      if (tab !== correctTab) {
        setTab(correctTab);
      }
      // Clear any status filter to ensure message is visible
      if (statusFilter !== 'all') {
        setStatusFilter('all');
      }
      setSelectedMessage(msg);
    } catch (err) {
      console.error('[Messages] Failed to fetch highlighted message:', err);
    }
  };

  // Handle highlight from URL params — unified for all sources (SW, iOS, direct link)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const highlightId = params.get('highlight');
    const urlTimestamp = params.get('_t');

    if (highlightId) {
      const tsKey = urlTimestamp || 'no-ts';
      if (tsKey !== lastMsgHighlightRef.current) {
        lastMsgHighlightRef.current = tsKey;
        highlightMessage(highlightId);
        // Clear params from URL
        navigate(location.pathname, { replace: true });
      }
    }
  }, [location.search]);

  const fetchMessages = async () => {
    try {
      const res = await api.get('/api/messages', { params: { tab, status: statusFilter } });
      setMessages(res.data);
      // Update selectedMessage if it's in the new list (keeps detail view fresh)
      setSelectedMessage(prev => {
        if (!prev) return null;
        const updated = res.data.find(m => (m.id || m._id) === (prev.id || prev._id));
        return updated || prev;
      });
    } catch (err) {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingCount = async () => {
    try {
      const res = await api.get('/api/messages/pending-count');
      setPendingCount(res.data.count);
    } catch (err) { /* ignore */ }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get('/api/auth/users');
      setUsers(res.data.filter(u => u.id !== user.id));
    } catch (err) { /* ignore */ }
  };

  const fetchContactsAndTasks = async () => {
    try {
      const [cRes, tRes] = await Promise.all([
        api.get('/api/contacts'),
        api.get('/api/tasks')
      ]);
      setContacts(cRes.data);
      setTasks(tRes.data);
    } catch (err) { /* ignore */ }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.toUserId || !form.subject.trim()) return;
    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('toUserId', form.toUserId);
      formData.append('type', form.type);
      formData.append('subject', form.subject.trim());
      formData.append('description', form.description.trim());
      if (form.linkedType && form.linkedId) {
        formData.append('linkedType', form.linkedType);
        formData.append('linkedId', form.linkedId);
        formData.append('linkedName', form.linkedName);
      }
      if (form.dueDate) formData.append('dueDate', form.dueDate);
      if (form.type === 'poll') {
        formData.append('pollOptions', JSON.stringify(form.pollOptions.filter(o => o.trim())));
        formData.append('pollMultipleChoice', form.pollMultipleChoice);
      }
      if (attachment) formData.append('attachment', attachment);

      await api.post('/api/messages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      setShowForm(false);
      resetForm();
      // setTab triggers useEffect which fetches messages — no manual fetch needed
      setTab('sent');
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri odosielaní');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setForm({ toUserId: '', type: 'approval', subject: '', description: '', linkedType: '', linkedId: '', linkedName: '', dueDate: '', pollOptions: ['', ''], pollMultipleChoice: false });
    setAttachment(null);
  };

  const handleApprove = async (id) => {
    try {
      const res = await api.put(`/api/messages/${id}/approve`);
      setSelectedMessage(res.data);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleReject = async (id) => {
    try {
      const res = await api.put(`/api/messages/${id}/reject`, { reason: rejectReason });
      setSelectedMessage(res.data);
      setShowRejectDialog(false);
      setRejectReason('');
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleComment = async (id) => {
    if (!commentText.trim()) return;
    try {
      const formData = new FormData();
      formData.append('text', commentText.trim());
      if (commentAttachment) formData.append('attachment', commentAttachment);
      const res = await api.post(`/api/messages/${id}/comment`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSelectedMessage(res.data);
      setCommentText('');
      setCommentAttachment(null);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleEdit = async (id, editData) => {
    try {
      const formData = new FormData();
      formData.append('subject', editData.subject);
      formData.append('description', editData.description);
      formData.append('type', editData.type);
      formData.append('dueDate', editData.dueDate || '');
      if (editData.linkedType) {
        formData.append('linkedType', editData.linkedType);
        formData.append('linkedId', editData.linkedId);
        formData.append('linkedName', editData.linkedName);
      }
      if (editData.newAttachment) {
        formData.append('attachment', editData.newAttachment);
      } else if (editData.removeAttachment) {
        formData.append('removeAttachment', 'true');
      }
      const res = await api.put(`/api/messages/${id}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setSelectedMessage(res.data);
      setEditing(false);
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri ukladaní');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Naozaj chcete vymazať tento odkaz?')) return;
    try {
      await api.delete(`/api/messages/${id}`);
      setSelectedMessage(null);
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
    }
  };

  const handleLinkedChange = (linkedType, linkedId) => {
    let linkedName = '';
    if (linkedType === 'contact') {
      linkedName = contacts.find(c => c.id === linkedId)?.name || '';
    } else if (linkedType === 'task') {
      linkedName = tasks.find(t => t.id === linkedId)?.title || '';
    }
    setForm(f => ({ ...f, linkedType, linkedId, linkedName }));
  };

  const handleVote = async (messageId, optionId) => {
    try {
      const res = await api.post(`/api/messages/${messageId}/vote`, { optionId });
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri hlasovaní');
    }
  };

  // File helpers
  const getFileIcon = (mimetype) => {
    if (mimetype?.startsWith('image/')) return '🖼️';
    if (mimetype?.includes('pdf')) return '📄';
    if (mimetype?.includes('word') || mimetype?.includes('document')) return '📝';
    if (mimetype?.includes('sheet') || mimetype?.includes('excel')) return '📊';
    if (mimetype?.includes('presentation') || mimetype?.includes('powerpoint')) return '📽️';
    if (mimetype?.startsWith('video/')) return '🎬';
    if (mimetype?.startsWith('audio/')) return '🎵';
    return '📎';
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const triggerMsgFileUpload = (messageId) => {
    setActiveFileMessageId(messageId);
    setTimeout(() => msgFileInputRef.current?.click(), 0);
  };

  const onMsgFileSelected = (e) => {
    const file = e.target.files[0];
    if (!file || !activeFileMessageId) return;
    handleMsgFileUpload(activeFileMessageId, file);
    e.target.value = '';
  };

  const handleMsgFileUpload = async (messageId, file) => {
    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post(`/api/messages/${messageId}/files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000
      });
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri nahrávaní súboru');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleMsgFileDownload = async (messageId, fileId, fileName) => {
    try {
      const response = await api.get(`/api/messages/${messageId}/files/${fileId}/download`, { responseType: 'blob' });
      downloadBlob(response.data, fileName);
    } catch (error) {
      alert('Chyba pri sťahovaní súboru');
    }
  };

  const handleMsgFileDelete = async (messageId, fileId) => {
    if (!window.confirm('Vymazať tento súbor?')) return;
    try {
      const res = await api.delete(`/api/messages/${messageId}/files/${fileId}`);
      setSelectedMessage(res.data);
      fetchMessages();
    } catch (error) {
      alert('Chyba pri mazaní súboru');
    }
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '';
  const formatDateTime = (d) => d ? new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const isRecipient = (msg) => {
    const toId = msg.toUserId?._id?.toString?.() || msg.toUserId?.toString?.() || msg.toUserId;
    return toId === user.id;
  };

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <button className="btn-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu">
            <span></span>
            <span></span>
            <span></span>
          </button>
          <HeaderLogo />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button className="btn btn-secondary" onClick={() => navigate('/crm')}>Kontakty</button>
          <button className="btn btn-secondary" onClick={() => navigate('/tasks')}>Projekty</button>
          <UserMenu user={user} onLogout={logout} onUserUpdate={updateUser} />
        </div>
      </header>

      <div className="crm-content">
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />
        <aside className={`crm-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <button
            className="btn btn-primary add-contact-btn"
            onClick={() => {
              setShowForm(true);
              setSidebarOpen(false);
            }}
          >
            + Nová správa
          </button>

          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('all'); setSidebarOpen(false); }}
            >
              <span className="stat-label">Celkom správ</span>
              <span className="stat-value">{receivedMessages.length}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa stavu</h4>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'pending' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('pending'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#F59E0B' }}></span>
                Čaká
              </span>
              <span className="stat-value">{pendingMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'approved' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('approved'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Schválené
              </span>
              <span className="stat-value">{approvedMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'rejected' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('rejected'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zamietnuté
              </span>
              <span className="stat-value">{rejectedMessages.length}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${statusFilter === 'commented' ? 'active' : ''}`}
              onClick={() => { setStatusFilter('commented'); setSidebarOpen(false); }}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Komentované
              </span>
              <span className="stat-value">{commentedMessages.length}</span>
            </div>
          </div>
        </aside>

        <main className="crm-main">
        <div className="messages-container" style={{ padding: '20px', maxWidth: '900px', margin: '0 auto', width: '100%' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600 }}>✉️ Správy</h2>
            {pendingCount > 0 && (
              <span style={{ background: 'var(--danger)', color: 'white', borderRadius: '10px', padding: '2px 8px', fontSize: '12px', fontWeight: 600 }}>{pendingCount}</span>
            )}
            <HelpGuide tips={messagesHelpTips} />
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '0', marginBottom: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '3px', border: '1px solid var(--border-color)' }}>
            <button
              onClick={() => { setTab('received'); setSelectedMessage(null); }}
              style={{
                flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                borderRadius: 'calc(var(--radius-md) - 2px)',
                background: tab === 'received' ? 'var(--accent-color)' : 'transparent',
                color: tab === 'received' ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
              }}
            >
              📥 Prijaté {pendingCount > 0 && <span style={{ background: tab === 'received' ? 'rgba(255,255,255,0.25)' : 'var(--danger)', color: 'white', borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 700 }}>{pendingCount}</span>}
            </button>
            <button
              onClick={() => { setTab('sent'); setSelectedMessage(null); }}
              style={{
                flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                borderRadius: 'calc(var(--radius-md) - 2px)',
                background: tab === 'sent' ? 'var(--accent-color)' : 'transparent',
                color: tab === 'sent' ? 'white' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
              }}
            >
              📤 Odoslané
            </button>
          </div>

          {/* Status filter */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {['all', 'pending', 'approved', 'rejected', 'commented'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                style={{
                  padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)',
                  background: statusFilter === s ? 'var(--accent-color)' : 'var(--bg-card)',
                  color: statusFilter === s ? 'white' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0
                }}
              >
                {s === 'all' ? 'Všetky' : statusConfig[s]?.label || s}
              </button>
            ))}
          </div>

          {/* Message list OR detail */}
          {selectedMessage ? (
            <MessageDetail
              msg={selectedMessage}
              isRecipient={isRecipient(selectedMessage)}
              isSender={selectedMessage.fromUserId === user.id || selectedMessage.fromUserId?._id === user.id}
              canDelete={(selectedMessage.fromUserId === user.id || selectedMessage.fromUserId?._id === user.id) || currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'manager'}
              onBack={() => setSelectedMessage(null)}
              onApprove={handleApprove}
              onReject={() => setShowRejectDialog(true)}
              onComment={handleComment}
              onDelete={handleDelete}
              onEdit={handleEdit}
              editing={editing}
              setEditing={setEditing}
              commentText={commentText}
              setCommentText={setCommentText}
              commentAttachment={commentAttachment}
              setCommentAttachment={setCommentAttachment}
              formatDate={formatDate}
              formatDateTime={formatDateTime}
              navigate={navigate}
              contacts={contacts}
              tasks={tasks}
              userId={user.id}
              onVote={handleVote}
              onFileUpload={triggerMsgFileUpload}
              onFileDownload={handleMsgFileDownload}
              onFileDelete={handleMsgFileDelete}
              uploadingFile={uploadingFile}
              getFileIcon={getFileIcon}
              formatFileSize={formatFileSize}
            />
          ) : (
            <MessageList
              messages={messages}
              loading={loading}
              tab={tab}
              onSelect={setSelectedMessage}
              formatDate={formatDate}
              formatDateTime={formatDateTime}
              userId={user.id}
            />
          )}
        </div>
        <input type="file" ref={msgFileInputRef} style={{ display: 'none' }} onChange={onMsgFileSelected} />
      </main>
      </div>

      {/* New message modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); resetForm(); } }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '100%', maxWidth: '520px', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-xl)' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '18px' }}>Nová správa</h3>
            <form onSubmit={handleSubmit}>
              {/* Recipient */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Komu *</label>
                <select value={form.toUserId} onChange={e => setForm(f => ({ ...f, toUserId: e.target.value }))} required
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }}>
                  <option value="">Vyberte príjemcu...</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.username} ({u.email})</option>)}
                </select>
              </div>

              {/* Type */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Typ *</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {Object.entries(typeConfig).map(([key, cfg]) => (
                    <button key={key} type="button"
                      onClick={() => setForm(f => ({ ...f, type: key }))}
                      style={{
                        padding: '6px 12px', borderRadius: 'var(--radius-sm)',
                        border: form.type === key ? `2px solid ${cfg.color}` : '1px solid var(--border-color)',
                        background: form.type === key ? `${cfg.color}15` : 'transparent',
                        cursor: 'pointer', fontSize: '13px'
                      }}>
                      {cfg.icon} {cfg.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subject */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Predmet *</label>
                <input type="text" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} required maxLength={200}
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }}
                  placeholder="Stručný názov odkazu" />
              </div>

              {/* Description */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Popis</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} maxLength={5000} rows={4}
                  style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical' }}
                  placeholder="Podrobnejší popis..." />
              </div>

              {/* Poll options (only for poll type) */}
              {form.type === 'poll' && (
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Možnosti ankety *</label>
                  {form.pollOptions.map((opt, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: '20px' }}>{i + 1}.</span>
                      <input type="text" value={opt} onChange={e => {
                        const newOpts = [...form.pollOptions];
                        newOpts[i] = e.target.value;
                        setForm(f => ({ ...f, pollOptions: newOpts }));
                      }} maxLength={200} placeholder={`Možnosť ${i + 1}`}
                        style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
                      {form.pollOptions.length > 2 && (
                        <button type="button" onClick={() => {
                          const newOpts = form.pollOptions.filter((_, j) => j !== i);
                          setForm(f => ({ ...f, pollOptions: newOpts }));
                        }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '16px', padding: '4px' }}>×</button>
                      )}
                    </div>
                  ))}
                  {form.pollOptions.length < 10 && (
                    <button type="button" onClick={() => setForm(f => ({ ...f, pollOptions: [...f.pollOptions, ''] }))}
                      style={{ background: 'none', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-secondary)', width: '100%' }}>
                      + Pridať možnosť
                    </button>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.pollMultipleChoice} onChange={e => setForm(f => ({ ...f, pollMultipleChoice: e.target.checked }))} />
                    Povoliť výber viacerých možností
                  </label>
                </div>
              )}

              {/* Link to contact or task */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Prepojenie (voliteľné)</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select value={form.linkedType} onChange={e => { setForm(f => ({ ...f, linkedType: e.target.value, linkedId: '', linkedName: '' })); }}
                    style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                    <option value="">Žiadne</option>
                    <option value="contact">Kontakt</option>
                    <option value="task">Projekt</option>
                  </select>
                  {form.linkedType && (
                    <select value={form.linkedId} onChange={e => handleLinkedChange(form.linkedType, e.target.value)}
                      style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                      <option value="">Vyberte...</option>
                      {form.linkedType === 'contact' && contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      {form.linkedType === 'task' && tasks.filter(t => !t.completed).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {/* Due date */}
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Termín (voliteľný)</label>
                <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                  style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
              </div>

              {/* Attachment */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Príloha (voliteľná)</label>
                <input type="file" onChange={e => setAttachment(e.target.files[0] || null)}
                  style={{ fontSize: '13px' }} />
                {attachment && <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px' }}>{(attachment.size / 1024 / 1024).toFixed(1)} MB</span>}
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); resetForm(); }}>Zrušiť</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Odosielam...' : 'Odoslať'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject dialog */}
      {showRejectDialog && selectedMessage && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowRejectDialog(false); }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '100%', maxWidth: '400px', boxShadow: 'var(--shadow-xl)' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '16px' }}>❌ Zamietnuť odkaz</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>Voliteľne uveďte dôvod zamietnutia:</p>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical', marginBottom: '12px' }}
              placeholder="Dôvod zamietnutia..." />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowRejectDialog(false)}>Zrušiť</button>
              <button className="btn" style={{ background: 'var(--danger)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                onClick={() => handleReject(selectedMessage.id || selectedMessage._id)}>
                Zamietnuť
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Message List ---
function MessageList({ messages, loading, tab, onSelect, formatDate, formatDateTime, userId }) {
  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Načítavam...</div>;
  if (messages.length === 0) return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '40px', marginBottom: '8px' }}>✉️</div>
      <p>{tab === 'received' ? 'Žiadne prijaté odkazy' : 'Žiadne odoslané odkazy'}</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {messages.map(msg => {
        const type = typeConfig[msg.type] || typeConfig.info;
        const status = statusConfig[msg.status] || statusConfig.pending;
        const isOverdue = msg.dueDate && msg.status === 'pending' && new Date(msg.dueDate) < new Date();

        return (
          <div key={msg.id || msg._id}
            onClick={() => onSelect(msg)}
            style={{
              padding: '12px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--border-color)',
              background: 'var(--bg-card)', cursor: 'pointer', transition: 'var(--transition)',
              borderLeft: `3px solid ${type.color}`,
              opacity: msg.status === 'approved' || msg.status === 'rejected' ? 0.75 : 1
            }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '14px' }}>{type.icon}</span>
              <span style={{ fontWeight: 600, fontSize: '14px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {msg.subject}
              </span>
              <span style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: `${status.color}15`, color: status.color, fontWeight: 500, whiteSpace: 'nowrap' }}>
                {status.icon} {status.label}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>{tab === 'received' ? `Od: ${msg.fromUsername}` : `Pre: ${msg.toUsername}`}</span>
              <span>{formatDateTime(msg.createdAt)}</span>
              {msg.dueDate && (
                <span style={{ color: isOverdue ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {isOverdue ? '⚠️' : '📅'} {formatDate(msg.dueDate)}
                </span>
              )}
              {(msg.attachment?.originalName || msg.files?.length > 0) && <span>📎 {(msg.files?.length || 0) + (msg.attachment?.originalName ? 1 : 0)}</span>}
              {msg.type === 'poll' && msg.pollOptions && <span>📊 {msg.pollOptions.reduce((s, o) => s + (o.votes?.length || 0), 0)} hlasov</span>}
              {msg.linkedName && <span>{msg.linkedType === 'contact' ? '👤' : '📋'} {msg.linkedName}</span>}
              {msg.comments?.length > 0 && <span>💬 {msg.comments.length}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Message Detail ---
function MessageDetail({ msg, isRecipient, isSender, canDelete, onBack, onApprove, onReject, onComment, onDelete, onEdit, editing, setEditing, commentText, setCommentText, commentAttachment, setCommentAttachment, formatDate, formatDateTime, navigate, contacts, tasks, userId, onVote, onFileUpload, onFileDownload, onFileDelete, uploadingFile, getFileIcon, formatFileSize, scrollToComments }) {
  const type = typeConfig[msg.type] || typeConfig.info;
  const status = statusConfig[msg.status] || statusConfig.pending;
  const commentsEndRef = useRef(null);

  // Auto-scroll to last comment on mount and when comments change
  useEffect(() => {
    if (commentsEndRef.current && msg.comments?.length > 0) {
      commentsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [msg.comments?.length, scrollToComments]);

  const [editForm, setEditForm] = useState({
    subject: msg.subject || '',
    description: msg.description || '',
    type: msg.type || 'info',
    dueDate: msg.dueDate ? msg.dueDate.substring(0, 10) : '',
    linkedType: msg.linkedType || '',
    linkedId: msg.linkedId || '',
    linkedName: msg.linkedName || '',
    newAttachment: null,
    removeAttachment: false
  });

  // Reset edit form when message changes
  useEffect(() => {
    setEditForm({
      subject: msg.subject || '',
      description: msg.description || '',
      type: msg.type || 'info',
      dueDate: msg.dueDate ? msg.dueDate.substring(0, 10) : '',
      linkedType: msg.linkedType || '',
      linkedId: msg.linkedId || '',
      linkedName: msg.linkedName || '',
      newAttachment: null,
      removeAttachment: false
    });
  }, [msg]);

  const handleLinkedChangeEdit = (lType, lId) => {
    let name = '';
    if (lType === 'contact') name = contacts?.find(c => c.id === lId)?.name || '';
    if (lType === 'task') name = tasks?.find(t => t.id === lId)?.title || '';
    setEditForm(f => ({ ...f, linkedId: lId, linkedName: name }));
  };

  if (editing) {
    return (
      <div>
        <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '14px', marginBottom: '12px' }}>
          ← Zrušiť úpravu
        </button>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '20px' }}>
          <h3 style={{ marginBottom: '16px', fontSize: '18px' }}>Upraviť správu</h3>

          {/* Type */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Typ</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {Object.entries(typeConfig).map(([key, cfg]) => (
                <button key={key} type="button"
                  onClick={() => setEditForm(f => ({ ...f, type: key }))}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius-sm)',
                    border: editForm.type === key ? `2px solid ${cfg.color}` : '1px solid var(--border-color)',
                    background: editForm.type === key ? `${cfg.color}15` : 'transparent',
                    cursor: 'pointer', fontSize: '13px'
                  }}>
                  {cfg.icon} {cfg.label}
                </button>
              ))}
            </div>
          </div>

          {/* Subject */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Predmet *</label>
            <input type="text" value={editForm.subject} onChange={e => setEditForm(f => ({ ...f, subject: e.target.value }))} maxLength={200}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
          </div>

          {/* Description */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Popis</label>
            <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} maxLength={5000} rows={4}
              style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px', resize: 'vertical' }} />
          </div>

          {/* Link */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Prepojenie</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select value={editForm.linkedType} onChange={e => setEditForm(f => ({ ...f, linkedType: e.target.value, linkedId: '', linkedName: '' }))}
                style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                <option value="">Žiadne</option>
                <option value="contact">Kontakt</option>
                <option value="task">Projekt</option>
              </select>
              {editForm.linkedType && (
                <select value={editForm.linkedId} onChange={e => handleLinkedChangeEdit(editForm.linkedType, e.target.value)}
                  style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
                  <option value="">Vyberte...</option>
                  {editForm.linkedType === 'contact' && contacts?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {editForm.linkedType === 'task' && tasks?.filter(t => !t.completed).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* Due date */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Termín</label>
            <input type="date" value={editForm.dueDate} onChange={e => setEditForm(f => ({ ...f, dueDate: e.target.value }))}
              style={{ padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '14px' }} />
          </div>

          {/* Attachment */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px', color: 'var(--text-secondary)' }}>Príloha</label>
            {msg.attachment?.originalName && !editForm.removeAttachment && !editForm.newAttachment && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                <span>📎 {msg.attachment.originalName}</span>
                <button onClick={() => setEditForm(f => ({ ...f, removeAttachment: true }))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '13px' }}>× Odstrániť</button>
              </div>
            )}
            <input type="file" onChange={e => setEditForm(f => ({ ...f, newAttachment: e.target.files[0] || null, removeAttachment: false }))}
              style={{ fontSize: '13px' }} />
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>Zrušiť</button>
            <button className="btn btn-primary" disabled={!editForm.subject.trim()}
              onClick={() => onEdit(msg.id || msg._id, editForm)}>
              Uložiť zmeny
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
        ← Späť
      </button>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '20px', borderLeft: `4px solid ${type.color}` }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '18px' }}>{type.icon}</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${type.color}15`, color: type.color, fontWeight: 500 }}>{type.label}</span>
              <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: `${status.color}15`, color: status.color, fontWeight: 500 }}>{status.icon} {status.label}</span>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 600 }}>{msg.subject}</h3>
          </div>
          {(isSender || canDelete) && (
            <div style={{ display: 'flex', gap: '8px' }}>
              {isSender && (
                <button onClick={() => setEditing(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '13px' }}>
                  ✏️ Upraviť
                </button>
              )}
              {canDelete && (
                <button onClick={() => onDelete(msg.id || msg._id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '13px' }}>
                  🗑️ Vymazať
                </button>
              )}
            </div>
          )}
        </div>

        {/* Meta */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
          <div><strong>Od:</strong> {msg.fromUsername}</div>
          <div><strong>Pre:</strong> {msg.toUsername}</div>
          <div><strong>Dátum:</strong> {formatDateTime(msg.createdAt)}</div>
          {msg.dueDate && <div><strong>Termín:</strong> {formatDate(msg.dueDate)}</div>}
          {msg.linkedName && (
            <div style={{ cursor: 'pointer', color: 'var(--accent-color)' }}
              onClick={() => {
                if (msg.linkedType === 'contact') navigate(`/crm?expandContact=${msg.linkedId}`);
                if (msg.linkedType === 'task') navigate(`/tasks?highlightTask=${msg.linkedId}`);
              }}>
              <strong>{msg.linkedType === 'contact' ? '👤 Kontakt:' : '📋 Projekt:'}</strong> {msg.linkedName}
            </div>
          )}
        </div>

        {/* Description */}
        {msg.description && (
          <div style={{ marginBottom: '16px', fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {msg.description}
          </div>
        )}


        {/* Poll section */}
        {msg.type === 'poll' && msg.pollOptions && msg.pollOptions.length > 0 && (() => {
          const totalVotes = msg.pollOptions.reduce((sum, opt) => sum + (opt.votes?.length || 0), 0);
          const userVotedOptions = msg.pollOptions.filter(opt => opt.votes?.some(v => v.userId === userId)).map(opt => opt._id);
          const hasVoted = userVotedOptions.length > 0;
          return (
            <div style={{ marginBottom: '16px', padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span style={{ fontSize: '16px' }}>📊</span>
                <strong style={{ fontSize: '14px' }}>Anketa</strong>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {totalVotes} {totalVotes === 1 ? 'hlas' : totalVotes >= 2 && totalVotes <= 4 ? 'hlasy' : 'hlasov'}
                  {msg.pollMultipleChoice && ' • viacero možností'}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {msg.pollOptions.map(opt => {
                  const voteCount = opt.votes?.length || 0;
                  const pct = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
                  const isMyVote = userVotedOptions.includes(opt._id);
                  return (
                    <button key={opt._id} type="button"
                      onClick={() => onVote(msg.id || msg._id, opt._id)}
                      style={{
                        position: 'relative', textAlign: 'left', padding: '10px 14px',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                        border: isMyVote ? '2px solid var(--accent-color)' : '1px solid var(--border-color)',
                        background: 'var(--bg-card)', overflow: 'hidden', fontSize: '14px',
                        transition: 'all 0.2s ease'
                      }}>
                      <div style={{
                        position: 'absolute', top: 0, left: 0, bottom: 0,
                        width: `${pct}%`, background: isMyVote ? 'rgba(var(--accent-rgb, 99, 102, 241), 0.12)' : 'rgba(0,0,0,0.04)',
                        transition: 'width 0.3s ease', borderRadius: 'var(--radius-sm)'
                      }} />
                      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: isMyVote ? 600 : 400 }}>
                          {isMyVote && '✓ '}{opt.text}
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px', whiteSpace: 'nowrap' }}>
                          {voteCount} ({pct}%)
                        </span>
                      </div>
                      {opt.votes?.length > 0 && (
                        <div style={{ position: 'relative', fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {opt.votes.map(v => v.username).join(', ')}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Files section */}
        <div className="task-files-section" style={{ marginBottom: '16px' }}>
          <div className="task-files-header">
            <span>📎 Prílohy ({(msg.files?.length || 0) + (msg.attachment?.originalName ? 1 : 0)})</span>
            {(isSender || isRecipient) && (
              <button
                className="btn btn-secondary btn-sm btn-attach"
                onClick={() => onFileUpload(msg.id || msg._id)}
                disabled={uploadingFile}
              >
                {uploadingFile ? '⏳' : '+'} Pridať
              </button>
            )}
          </div>

          {/* File list */}
          {(msg.attachment?.originalName || (msg.files && msg.files.length > 0)) && (
            <div className="task-files-list">
              {/* Legacy single attachment */}
              {msg.attachment?.originalName && (
                <div className="task-file-item">
                  <span className="task-file-icon">{getFileIcon(msg.attachment.mimetype)}</span>
                  <span className="task-file-name" title={msg.attachment.originalName}>{msg.attachment.originalName}</span>
                  <span className="task-file-size">{formatFileSize(msg.attachment.size)}</span>
                  <button className="btn-icon-sm" onClick={() => {
                    api.get(`/api/messages/${msg.id || msg._id}/attachment`, { responseType: 'blob' })
                      .then(res => downloadBlob(res.data, msg.attachment.originalName));
                  }} title="Stiahnuť">⬇️</button>
                </div>
              )}
              {/* Multi-file attachments */}
              {msg.files?.map(file => (
                <div key={file.id} className="task-file-item">
                  <span className="task-file-icon">{getFileIcon(file.mimetype)}</span>
                  <span className="task-file-name" title={file.originalName}>{file.originalName}</span>
                  <span className="task-file-size">{formatFileSize(file.size)}</span>
                  <button className="btn-icon-sm" onClick={() => onFileDownload(msg.id || msg._id, file.id, file.originalName)} title="Stiahnuť">⬇️</button>
                  {(isSender || isRecipient) && (
                    <button className="btn-icon-sm btn-delete" onClick={() => onFileDelete(msg.id || msg._id, file.id)} title="Vymazať">×</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {uploadingFile && (
            <p style={{ fontSize: '12px', color: 'var(--accent-color)', marginTop: '4px' }}>Nahrávam súbor...</p>
          )}
        </div>

        {/* Rejection reason */}
        {msg.status === 'rejected' && msg.rejectionReason && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
            <strong>Dôvod zamietnutia:</strong> {msg.rejectionReason}
          </div>
        )}

        {/* Actions for recipient */}
        {isRecipient && (msg.status === 'pending' || msg.status === 'commented') && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => onApprove(msg.id || msg._id)}
              style={{ background: 'var(--success)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px' }}>
              ✅ Schváliť
            </button>
            <button className="btn" onClick={onReject}
              style={{ background: 'var(--danger)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '13px' }}>
              ❌ Zamietnuť
            </button>
          </div>
        )}

        {/* Comments */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>💬 Komentáre ({msg.comments?.length || 0})</h4>

          {msg.comments && msg.comments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
              {msg.comments.map((c, i) => (
                <div key={c._id || i} style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong>{c.username}</strong>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{formatDateTime(c.createdAt)}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
                  {c.attachment?.originalName && (
                    <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>📎</span>
                      <a href="#" onClick={(e) => {
                          e.preventDefault();
                          api.get(`/api/messages/${msg.id || msg._id}/comment/${c._id}/attachment`, { responseType: 'blob' })
                            .then(res => {
                              const url = URL.createObjectURL(res.data);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = c.attachment.originalName;
                              a.click();
                              URL.revokeObjectURL(url);
                            });
                        }}
                        style={{ fontSize: '12px', color: 'var(--accent-color)' }}>
                        {c.attachment.originalName}
                      </a>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({(c.attachment.size / 1024).toFixed(0)} KB)</span>
                    </div>
                  )}
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}

          {/* Add comment */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onComment(msg.id || msg._id); } }}
                style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
                placeholder="Napíšte komentár..." />
              <button className="btn btn-primary" onClick={() => onComment(msg.id || msg._id)}
                disabled={!commentText.trim()} style={{ fontSize: '13px', padding: '6px 14px', width: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
                Odoslať
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Messages;
