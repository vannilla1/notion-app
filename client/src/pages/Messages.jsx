import { useState, useEffect, useRef } from 'react';
import api, { API_BASE_URL } from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from '../components/UserMenu';
import HelpGuide from '../components/HelpGuide';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';

const messagesHelpTips = [
  { icon: '📨', title: 'Odkazy', description: 'Posielajte interné správy členom tímu — žiadosti o schválenie, návrhy, informácie alebo žiadosti.' },
  { icon: '🟡', title: 'Typy odkazov', description: 'Schválenie (žltá) — vyžaduje rozhodnutie. Informácia (modrá) — len na prečítanie. Žiadosť (oranžová) — prosba o akciu. Návrh (zelená) — diskusia.' },
  { icon: '✅', title: 'Akcie príjemcu', description: 'Prijaté odkazy môžete schváliť, zamietnuť alebo komentovať. Po schválení/zamietnutí sa stav nedá zmeniť.' },
  { icon: '📎', title: 'Prílohy', description: 'Ku každému odkazu môžete priložiť súbor do 10MB — dokumenty, obrázky, PDF.' },
  { icon: '🔗', title: 'Prepojenia', description: 'Odkaz môžete prepojiť s konkrétnym kontaktom alebo projektom pre jednoduchšiu orientáciu.' }
];

const typeConfig = {
  approval: { label: 'Schválenie', icon: '🟡', color: '#F59E0B' },
  info: { label: 'Informácia', icon: '🔵', color: '#3B82F6' },
  request: { label: 'Žiadosť', icon: '🟠', color: '#F97316' },
  proposal: { label: 'Návrh', icon: '🟢', color: '#10B981' }
};

const statusConfig = {
  pending: { label: 'Čaká', icon: '🕐', color: '#F59E0B' },
  approved: { label: 'Schválené', icon: '✅', color: '#10B981' },
  rejected: { label: 'Zamietnuté', icon: '❌', color: '#EF4444' },
  commented: { label: 'Komentované', icon: '💬', color: '#6366F1' }
};

function Messages() {
  const { user, logout, updateUser } = useAuth();
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
    linkedType: '', linkedId: '', linkedName: '', dueDate: ''
  });
  const [attachment, setAttachment] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Detail view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Stats for sidebar
  const receivedMessages = messages;
  const pendingMessages = messages.filter(m => m.status === 'pending');
  const approvedMessages = messages.filter(m => m.status === 'approved');
  const rejectedMessages = messages.filter(m => m.status === 'rejected');
  const commentedMessages = messages.filter(m => m.status === 'commented');

  useEffect(() => { fetchMessages(); fetchPendingCount(); }, [tab, statusFilter]);

  useEffect(() => {
    if (showForm) { fetchUsers(); fetchContactsAndTasks(); }
  }, [showForm]);

  // Socket events
  useEffect(() => {
    if (!socket || !isConnected) return;
    const refresh = () => { fetchMessages(); fetchPendingCount(); };
    socket.on('message-created', refresh);
    socket.on('message-updated', refresh);
    socket.on('message-deleted', refresh);
    return () => {
      socket.off('message-created', refresh);
      socket.off('message-updated', refresh);
      socket.off('message-deleted', refresh);
    };
  }, [socket, isConnected]);

  // Deep link highlight
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const highlightId = params.get('highlight');
    if (highlightId && messages.length > 0) {
      const msg = messages.find(m => m.id === highlightId || m._id === highlightId);
      if (msg) setSelectedMessage(msg);
    }
  }, [location.search, messages]);

  const fetchMessages = async () => {
    try {
      const res = await api.get('/api/messages', { params: { tab, status: statusFilter } });
      setMessages(res.data);
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
      if (attachment) formData.append('attachment', attachment);

      await api.post('/api/messages', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      setShowForm(false);
      resetForm();
      setTab('sent');
      fetchMessages();
      fetchPendingCount();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba pri odosielaní');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setForm({ toUserId: '', type: 'approval', subject: '', description: '', linkedType: '', linkedId: '', linkedName: '', dueDate: '' });
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
      const res = await api.post(`/api/messages/${id}/comment`, { text: commentText.trim() });
      setSelectedMessage(res.data);
      setCommentText('');
      fetchMessages();
    } catch (err) {
      alert(err.response?.data?.message || 'Chyba');
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

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('sk-SK') : '';
  const formatDateTime = (d) => d ? new Date(d).toLocaleString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  const isRecipient = (msg) => msg.toUserId === user.id || msg.toUserId?._id === user.id;

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <button className="btn-menu" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu">
            <span></span>
            <span></span>
            <span></span>
          </button>
          <h1 className="header-title-link" onClick={() => navigate('/app')}>
            <img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />Prpl CRM
          </h1>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 600 }}>✉️ Odkazy</h2>
              {pendingCount > 0 && (
                <span style={{ background: 'var(--danger)', color: 'white', borderRadius: '10px', padding: '2px 8px', fontSize: '12px', fontWeight: 600 }}>{pendingCount}</span>
              )}
              <HelpGuide tips={messagesHelpTips} />
            </div>
            <button className="btn btn-primary" onClick={() => setShowForm(true)} style={{ fontSize: '14px' }}>
              + Nový odkaz
            </button>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '0' }}>
            <button
              onClick={() => { setTab('received'); setSelectedMessage(null); }}
              style={{
                padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 500,
                borderBottom: tab === 'received' ? '2px solid var(--accent-color)' : '2px solid transparent',
                color: tab === 'received' ? 'var(--accent-color)' : 'var(--text-secondary)'
              }}
            >
              Prijaté {pendingCount > 0 && tab !== 'received' && <span style={{ color: 'var(--danger)' }}>({pendingCount})</span>}
            </button>
            <button
              onClick={() => { setTab('sent'); setSelectedMessage(null); }}
              style={{
                padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 500,
                borderBottom: tab === 'sent' ? '2px solid var(--accent-color)' : '2px solid transparent',
                color: tab === 'sent' ? 'var(--accent-color)' : 'var(--text-secondary)'
              }}
            >
              Odoslané
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
              onBack={() => setSelectedMessage(null)}
              onApprove={handleApprove}
              onReject={() => setShowRejectDialog(true)}
              onComment={handleComment}
              onDelete={handleDelete}
              commentText={commentText}
              setCommentText={setCommentText}
              formatDate={formatDate}
              formatDateTime={formatDateTime}
              navigate={navigate}
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
      </main>
      </div>

      {/* New message modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); resetForm(); } }}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '24px', width: '100%', maxWidth: '520px', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-xl)' }}>
            <h3 style={{ marginBottom: '16px', fontSize: '18px' }}>Nový odkaz</h3>
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
              {msg.attachment?.originalName && <span>📎</span>}
              {msg.linkedName && <span>🔗 {msg.linkedName}</span>}
              {msg.comments?.length > 0 && <span>💬 {msg.comments.length}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Message Detail ---
function MessageDetail({ msg, isRecipient, isSender, onBack, onApprove, onReject, onComment, onDelete, commentText, setCommentText, formatDate, formatDateTime, navigate }) {
  const type = typeConfig[msg.type] || typeConfig.info;
  const status = statusConfig[msg.status] || statusConfig.pending;

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
          {isSender && msg.status === 'pending' && (
            <button onClick={() => onDelete(msg.id || msg._id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', fontSize: '13px' }}>
              🗑️ Vymazať
            </button>
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
              <strong>🔗</strong> {msg.linkedName}
            </div>
          )}
        </div>

        {/* Description */}
        {msg.description && (
          <div style={{ marginBottom: '16px', fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {msg.description}
          </div>
        )}

        {/* Attachment */}
        {msg.attachment?.originalName && (
          <div style={{ marginBottom: '16px', padding: '10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>📎</span>
            <a href={`${API_BASE_URL}/api/messages/${msg.id || msg._id}/attachment`}
              target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-color)', fontSize: '13px', textDecoration: 'none' }}
              onClick={e => {
                e.preventDefault();
                api.get(`/api/messages/${msg.id || msg._id}/attachment`, { responseType: 'blob' })
                  .then(res => {
                    const url = window.URL.createObjectURL(new Blob([res.data]));
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = msg.attachment.originalName;
                    a.click();
                    window.URL.revokeObjectURL(url);
                  });
              }}>
              {msg.attachment.originalName}
            </a>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({(msg.attachment.size / 1024).toFixed(0)} KB)</span>
          </div>
        )}

        {/* Rejection reason */}
        {msg.status === 'rejected' && msg.rejectionReason && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
            <strong>Dôvod zamietnutia:</strong> {msg.rejectionReason}
          </div>
        )}

        {/* Actions for recipient */}
        {isRecipient && msg.status === 'pending' && (
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
                </div>
              ))}
            </div>
          )}

          {/* Add comment */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onComment(msg.id || msg._id); } }}
              style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '13px' }}
              placeholder="Napíšte komentár..." />
            <button className="btn btn-primary" onClick={() => onComment(msg.id || msg._id)}
              disabled={!commentText.trim()} style={{ fontSize: '13px', padding: '8px 12px' }}>
              Odoslať
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Messages;
