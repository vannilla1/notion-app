import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate } from 'react-router-dom';
import UserMenu from '../components/UserMenu';
import HelpGuide from '../components/HelpGuide';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import HeaderLogo from '../components/HeaderLogo';

// Help tips for Dashboard
const dashboardHelpTips = [
  {
    icon: '📊',
    title: 'Prehľad štatistík',
    description: 'Na dashboarde vidíte prehľad vašich kontaktov a projektov. Kliknutím na štatistiku zobrazíte detailný zoznam.'
  },
  {
    icon: '👥',
    title: 'Kontakty podľa stavu',
    description: 'Kontakty sú radené podľa stavu: Nové a Aktívne prvé, Dokončené za nimi, Zrušené na konci — v rámci skupín abecedne. Kliknutím na kategóriu zobrazíte zoznam.'
  },
  {
    icon: '✅',
    title: 'Projekty podľa priority',
    description: 'Projekty sa radia podľa priority (Vysoká → Stredná → Nízka). Dokončené projekty sa zobrazujú na konci zoznamu.'
  },
  {
    icon: '🔔',
    title: 'Notifikácie',
    description: 'V pravom hornom rohu nájdete zvonček s notifikáciami. Dostávate upozornenia na všetky zmeny vo workspace — nové kontakty, projekty, priradenia, termíny a správy. Push notifikácie fungujú aj na iOS. Notifikácie chodia len členom daného workspace.'
  },
  {
    icon: '🏢',
    title: 'Pracovné prostredia',
    description: 'Cez ikonu profilu v pravom hornom rohu môžete prepínať medzi pracovnými prostrediami alebo vytvoriť nové. Na mobilnej verzii sa názov aktuálneho prostredia zobrazuje v hlavičke pod logom.'
  },
  {
    icon: '📆',
    title: 'Google synchronizácia',
    description: 'V nastaveniach profilu prepojte Google Calendar a Google Tasks pre automatickú synchronizáciu vašich termínov a projektov.'
  },
  {
    icon: '✉️',
    title: 'Správy a ankety',
    description: 'V bočnom paneli vidíte prehľad správ podľa stavu (Čaká, Schválené, Zamietnuté, Komentované) a podľa typu (Ankety). Kliknutím na kategóriu zobrazíte zoznam správ. Počet ankiet zahŕňa prijaté aj odoslané.'
  },
  {
    icon: '⚡',
    title: 'Rýchla navigácia',
    description: 'Pomocou tlačidiel "Kontakty", "Projekty" a "Správy" v hlavičke alebo cez spodnú navigáciu sa rýchlo prepnete na detailné zobrazenie.'
  }
];

function Dashboard() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [messages, setMessages] = useState({ received: [], sent: [] });
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { socket, isConnected } = useSocket();

  // Detail view state
  const [detailView, setDetailView] = useState(null); // 'contacts', 'tasks', 'active', 'pending', 'completed', 'contactTasks'
  const [selectedContact, setSelectedContact] = useState(null);
  const [messageTab, setMessageTab] = useState('received'); // 'received' | 'sent'

  // Task editing state
  const [expandedTask, setExpandedTask] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [subtaskEditForm, setSubtaskEditForm] = useState({});
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  // Debounced fetch — coalesce rapid socket events into one API call
  const fetchTimerRef = useRef(null);
  const debouncedFetch = useCallback(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => fetchData(), 300);
  }, []);

  useEffect(() => {
    fetchData();
    return () => { if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current); };
  }, []);

  // Refresh when app returns from background
  useEffect(() => {
    const handleResume = () => fetchData();
    window.addEventListener('app-resumed', handleResume);
    return () => window.removeEventListener('app-resumed', handleResume);
  }, []);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const events = ['contact-created', 'contact-updated', 'contact-deleted', 'task-updated', 'task-created', 'task-deleted', 'new-message'];
    events.forEach(e => socket.on(e, debouncedFetch));
    return () => events.forEach(e => socket.off(e, debouncedFetch));
  }, [socket, isConnected, debouncedFetch]);

  const fetchData = async () => {
    try {
      const [contactsRes, tasksRes, receivedRes, sentRes] = await Promise.all([
        api.get('/api/contacts'),
        api.get('/api/tasks'),
        api.get('/api/messages?tab=received'),
        api.get('/api/messages?tab=sent')
      ]);
      setContacts(contactsRes.data);
      setTasks(tasksRes.data);
      setMessages({ received: receivedRes.data, sent: sentRes.data });
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'new': return '#3B82F6';
      case 'active': return '#10B981';
      case 'completed': return '#6366F1';
      case 'cancelled': return '#EF4444';
      default: return '#9CA3AF';
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'new': return 'Nový';
      case 'active': return 'Aktívny';
      case 'completed': return 'Dokončený';
      case 'cancelled': return 'Zrušený';
      default: return status;
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'high': return '#EF4444';
      case 'medium': return '#F59E0B';
      case 'low': return '#10B981';
      default: return '#9CA3AF';
    }
  };

  const getPriorityLabel = (priority) => {
    switch (priority) {
      case 'high': return 'Vysoka';
      case 'medium': return 'Stredna';
      case 'low': return 'Nizka';
      default: return priority;
    }
  };

  // Helper function to get due date status class
  const getDueDateClass = (dueDate, completed) => {
    if (!dueDate || completed) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return 'overdue'; // po termíne - červená + výkričník
    if (diffDays <= 3) return 'due-danger'; // do 3 dní - červená
    if (diffDays <= 7) return 'due-warning'; // do 7 dní - žltá
    if (diffDays <= 14) return 'due-success'; // do 14 dní - zelená
    return '';
  };

  // Get all tasks for a contact (only embedded tasks)
  const getContactTasks = (contact) => {
    return (contact.tasks || []).map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      completed: t.completed,
      priority: t.priority,
      dueDate: t.dueDate,
      subtasks: t.subtasks || [],
      notes: t.notes,
      source: 'contact',
      contactId: contact.id
    }));
  };

  // Get contact names (supports multiple contacts)
  const getContactNames = (task) => {
    if (task.contactNames?.length > 0) {
      return task.contactNames;
    }
    if (task.contactName) {
      return [task.contactName];
    }
    const taskContactIds = task.contactIds?.length > 0
      ? task.contactIds
      : (task.contactId ? [task.contactId] : []);
    return taskContactIds
      .map(id => contacts.find(c => c.id === id)?.name)
      .filter(Boolean);
  };

  // Stats (memoized — recompute only when data changes)
  const stats = useMemo(() => {
    const activeTasks = tasks.filter(t => !t.completed);
    return {
      activeContacts: contacts.filter(c => c.status === 'active').length,
      newContacts: contacts.filter(c => c.status === 'new').length,
      completedContacts: contacts.filter(c => c.status === 'completed').length,
      cancelledContacts: contacts.filter(c => c.status === 'cancelled').length,
      pendingTasks: activeTasks.length,
      completedTasks: tasks.length - activeTasks.length,
      totalReceived: messages.received.length,
      pendingMessages: messages.received.filter(m => m.status === 'pending').length,
      approvedMessages: messages.received.filter(m => m.status === 'approved').length,
      rejectedMessages: messages.received.filter(m => m.status === 'rejected').length,
      commentedMessages: messages.received.filter(m => m.status === 'commented').length,
      pollMessages: [...messages.received, ...messages.sent].filter(m => m.type === 'poll').length,
      totalSent: messages.sent.length,
      lowPriorityTasks: activeTasks.filter(t => t.priority === 'low').length,
      mediumPriorityTasks: activeTasks.filter(t => t.priority === 'medium').length,
      highPriorityTasks: activeTasks.filter(t => t.priority === 'high').length,
    };
  }, [contacts, tasks, messages]);

  const { activeContacts, newContacts, completedContacts, cancelledContacts, pendingTasks, completedTasks, totalReceived, pendingMessages, approvedMessages, rejectedMessages, commentedMessages, pollMessages, totalSent, lowPriorityTasks, mediumPriorityTasks, highPriorityTasks } = stats;

  // Sort functions (stable references)
  const sortTasks = useCallback((list) => [...list].sort((a, b) => {
    const aCompleted = a.completed === true;
    const bCompleted = b.completed === true;
    if (aCompleted && !bCompleted) return 1;
    if (!aCompleted && bCompleted) return -1;
    const pri = { high: 0, medium: 1, low: 2 };
    return (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
  }), []);

  const sortContacts = useCallback((list) => [...list].sort((a, b) => {
    const order = { new: 0, active: 0, completed: 1, cancelled: 2 };
    const diff = (order[a.status] ?? 0) - (order[b.status] ?? 0);
    if (diff !== 0) return diff;
    return (a.name || '').localeCompare(b.name || '', 'sk');
  }), []);

  // Get items for detail view
  const getDetailItems = () => {
    switch (detailView) {
      case 'contacts':
        return { type: 'contacts', items: sortContacts(contacts), title: 'Všetky kontakty' };
      case 'active':
        return { type: 'contacts', items: sortContacts(contacts.filter(c => c.status === 'active')), title: 'Aktívne kontakty' };
      case 'new':
        return { type: 'contacts', items: sortContacts(contacts.filter(c => c.status === 'new')), title: 'Nove kontakty' };
      case 'completed-contacts':
        return { type: 'contacts', items: sortContacts(contacts.filter(c => c.status === 'completed')), title: 'Dokončené kontakty' };
      case 'cancelled':
        return { type: 'contacts', items: sortContacts(contacts.filter(c => c.status === 'cancelled')), title: 'Zrušené kontakty' };
      case 'tasks':
        return { type: 'tasks', items: sortTasks(tasks), title: 'Všetky projekty' };
      case 'pending':
        return { type: 'tasks', items: sortTasks(tasks.filter(t => !t.completed)), title: 'Nesplnené projekty' };
      case 'completed':
        return { type: 'tasks', items: sortTasks(tasks.filter(t => t.completed)), title: 'Splnené projekty' };
      case 'contactTasks':
        if (selectedContact) {
          return { type: 'tasks', items: sortTasks(getContactTasks(selectedContact)), title: `Projekty: ${selectedContact.name}` };
        }
        return null;
      case 'priority-low':
        return { type: 'tasks', items: sortTasks(tasks.filter(t => t.priority === 'low' && !t.completed)), title: 'Projekty s nízkou prioritou' };
      case 'priority-medium':
        return { type: 'tasks', items: sortTasks(tasks.filter(t => t.priority === 'medium' && !t.completed)), title: 'Projekty so strednou prioritou' };
      case 'priority-high':
        return { type: 'tasks', items: sortTasks(tasks.filter(t => t.priority === 'high' && !t.completed)), title: 'Projekty s vysokou prioritou' };
      case 'messages-all':
      case 'messages-pending':
      case 'messages-approved':
      case 'messages-rejected':
      case 'messages-commented':
      case 'messages-poll': {
        const statusKey = detailView.replace('messages-', '');
        const src = statusKey === 'poll'
          ? [...messages.received, ...messages.sent]
          : (messageTab === 'sent' ? messages.sent : messages.received);
        const filtered = statusKey === 'all' ? src : statusKey === 'poll' ? src.filter(m => m.type === 'poll') : src.filter(m => m.status === statusKey);
        const statusLabels = { all: 'Všetky', pending: 'Čakajúce', approved: 'Schválené', rejected: 'Zamietnuté', commented: 'Komentované', poll: 'Ankety' };
        const tabLabel = statusKey === 'poll' ? 'Všetky' : (messageTab === 'sent' ? 'Odoslané' : 'Prijaté');
        return { type: 'messages', items: filtered, title: `${tabLabel} — ${statusLabels[statusKey]} správy` };
      }
      default:
        return null;
    }
  };

  const closeDetailView = () => {
    setDetailView(null);
    setSelectedContact(null);
    setExpandedTask(null);
    setEditingTask(null);
  };

  const openContactTasks = (contact) => {
    setSelectedContact(contact);
    setDetailView('contactTasks');
  };

  // Task editing functions
  const startEditTask = (task) => {
    setEditingTask(task.id);
    setEditForm({
      title: task.title,
      description: task.description || '',
      dueDate: task.dueDate || '',
      priority: task.priority || 'medium'
    });
  };

  const cancelEditTask = () => {
    setEditingTask(null);
    setEditForm({});
  };

  const saveTask = async (task) => {
    try {
      if (task.source === 'contact' && task.contactId) {
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}`, editForm);
      } else {
        await api.put(`/api/tasks/${task.id}`, { ...editForm, source: task.source });
      }
      await fetchData();
      setEditingTask(null);
      setEditForm({});
    } catch (error) {
      alert('Chyba pri ukladaní projekty');
    }
  };

  const toggleTaskComplete = async (task) => {
    if (!task.completed) {
      if (!window.confirm(`Označiť projekt "${task.title}" ako dokončenú?`)) return;
    }
    try {
      if (task.source === 'contact' && task.contactId) {
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}`, { completed: !task.completed });
      } else {
        await api.put(`/api/tasks/${task.id}`, { completed: !task.completed, source: task.source });
      }
      await fetchData();
    } catch (error) {
      alert('Chyba pri aktualizácii projekty');
    }
  };

  // Subtask functions
  const startEditSubtask = (subtask) => {
    setEditingSubtask(subtask.id);
    setSubtaskEditForm({
      title: subtask.title,
      dueDate: subtask.dueDate || '',
      notes: subtask.notes || ''
    });
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setSubtaskEditForm({});
  };

  const saveSubtask = async (task, subtask) => {
    try {
      const updatedSubtasks = task.subtasks.map(s =>
        s.id === subtask.id ? { ...s, ...subtaskEditForm } : s
      );
      if (task.source === 'contact' && task.contactId) {
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}`, { subtasks: updatedSubtasks });
      } else {
        await api.put(`/api/tasks/${task.id}`, { subtasks: updatedSubtasks });
      }
      await fetchData();
      setEditingSubtask(null);
      setSubtaskEditForm({});
    } catch (error) {
      alert('Chyba pri ukladaní úlohy');
    }
  };

  const toggleSubtaskComplete = async (task, subtask) => {
    try {
      const updatedSubtasks = task.subtasks.map(s =>
        s.id === subtask.id ? { ...s, completed: !s.completed } : s
      );
      if (task.source === 'contact' && task.contactId) {
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}`, { subtasks: updatedSubtasks });
      } else {
        await api.put(`/api/tasks/${task.id}`, { subtasks: updatedSubtasks });
      }
      await fetchData();
    } catch (error) {
      alert('Chyba pri aktualizácii úlohy');
    }
  };

  // Helper to count all subtasks recursively
  const countSubtasksRecursive = (subtasks) => {
    if (!subtasks || subtasks.length === 0) return { total: 0, completed: 0 };
    let total = 0;
    let completed = 0;
    subtasks.forEach(s => {
      total++;
      if (s.completed) completed++;
      if (s.subtasks && s.subtasks.length > 0) {
        const childCounts = countSubtasksRecursive(s.subtasks);
        total += childCounts.total;
        completed += childCounts.completed;
      }
    });
    return { total, completed };
  };

  // Toggle expand/collapse for nested subtasks
  const toggleSubtaskExpanded = (subtaskId) => {
    setExpandedSubtasks(prev => ({
      ...prev,
      [subtaskId]: !prev[subtaskId]
    }));
  };

  // Recursive subtask renderer for Dashboard
  const renderDashboardSubtasks = (task, subtasks, depth = 0) => {
    if (!subtasks || subtasks.length === 0) return null;

    return subtasks.map(subtask => {
      const hasChildren = subtask.subtasks && subtask.subtasks.length > 0;
      const isExpanded = expandedSubtasks[subtask.id];
      const childCounts = hasChildren ? countSubtasksRecursive(subtask.subtasks) : { total: 0, completed: 0 };

      return (
        <div key={subtask.id} className="subtask-tree-item" style={{ marginLeft: depth * 16 }}>
          <div className={`dashboard-subtask-item ${subtask.completed ? 'completed' : ''}`}>
            <div
              className="subtask-checkbox"
              onClick={(e) => { e.stopPropagation(); toggleSubtaskComplete(task, subtask); }}
              style={{
                backgroundColor: subtask.completed ? 'var(--accent-color)' : 'transparent'
              }}
            >
              {subtask.completed && '✓'}
            </div>

            {hasChildren && (
              <button
                className="subtask-expand-btn"
                onClick={(e) => { e.stopPropagation(); toggleSubtaskExpanded(subtask.id); }}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}

            {editingSubtask === subtask.id ? (
              <div className="subtask-edit-inline" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={subtaskEditForm.title}
                  onChange={(e) => setSubtaskEditForm({ ...subtaskEditForm, title: e.target.value })}
                  className="form-input"
                  placeholder="Názov úlohy"
                  autoFocus
                />
                <div className="subtask-edit-row">
                  <input
                    type="date"
                    value={subtaskEditForm.dueDate}
                    onChange={(e) => setSubtaskEditForm({ ...subtaskEditForm, dueDate: e.target.value })}
                    className="form-input"
                  />
                  <input
                    type="text"
                    value={subtaskEditForm.notes}
                    onChange={(e) => setSubtaskEditForm({ ...subtaskEditForm, notes: e.target.value })}
                    className="form-input"
                    placeholder="Poznámky"
                  />
                </div>
                <div className="subtask-edit-actions">
                  <button onClick={() => saveSubtask(task, subtask)} className="btn btn-primary btn-sm">Uložiť</button>
                  <button onClick={cancelEditSubtask} className="btn btn-secondary btn-sm">Zrušiť</button>
                </div>
              </div>
            ) : (
              <>
                <div className="subtask-content">
                  <div className="subtask-title">{subtask.title}</div>
                  {(subtask.dueDate || subtask.notes) && (
                    <div className="subtask-meta">
                      {subtask.dueDate && (
                        <span className={`subtask-date ${getDueDateClass(subtask.dueDate, subtask.completed)}`}>
                          📅 {new Date(subtask.dueDate).toLocaleDateString('sk-SK')}
                        </span>
                      )}
                      {subtask.notes && (
                        <span className="subtask-notes">{subtask.notes}</span>
                      )}
                    </div>
                  )}
                </div>
                {hasChildren && (
                  <span className="subtask-child-count">
                    ({childCounts.completed}/{childCounts.total})
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); startEditSubtask(subtask); }}
                  className="btn-icon-sm"
                  title="Upraviť"
                >
                  ✏️
                </button>
              </>
            )}
          </div>

          {/* Nested subtasks */}
          {isExpanded && hasChildren && (
            <div className="subtask-children">
              {renderDashboardSubtasks(task, subtask.subtasks, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  const detailData = getDetailItems();

  return (
    <div className="crm-container">
      <header className="crm-header">
        <div className="crm-header-left">
          <button
            className="btn-menu"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Menu"
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
          <HeaderLogo active onClick={closeDetailView} />
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/crm')}
          >
            Kontakty
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/tasks')}
          >
            Projekty
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/messages')}
          >
            Správy
          </button>
          <UserMenu
            user={user}
            onLogout={logout}
            onUserUpdate={updateUser}
          />
        </div>
      </header>

      <div className="crm-content">
        <div
          className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

        <aside className={`crm-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${detailView === 'contacts' ? 'active' : ''}`}
              onClick={() => setDetailView('contacts')}
            >
              <span className="stat-label">Celkom kontaktov</span>
              <span className="stat-value">{contacts.length}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'active' ? 'active' : ''}`}
              onClick={() => setDetailView('active')}
            >
              <span className="stat-label">Aktívnych</span>
              <span className="stat-value">{activeContacts}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'tasks' ? 'active' : ''}`}
              onClick={() => setDetailView('tasks')}
            >
              <span className="stat-label">Globálnych projektov</span>
              <span className="stat-value">{tasks.length}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'pending' ? 'active' : ''}`}
              onClick={() => setDetailView('pending')}
            >
              <span className="stat-label">Nesplnených</span>
              <span className="stat-value">{pendingTasks}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'completed' ? 'active' : ''}`}
              onClick={() => setDetailView('completed')}
            >
              <span className="stat-label">Splnených</span>
              <span className="stat-value">{completedTasks}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa priority</h4>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'priority-high' ? 'active' : ''}`}
              onClick={() => setDetailView('priority-high')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Vysoka priorita
              </span>
              <span className="stat-value">{highPriorityTasks}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'priority-medium' ? 'active' : ''}`}
              onClick={() => setDetailView('priority-medium')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#F59E0B' }}></span>
                Stredna priorita
              </span>
              <span className="stat-value">{mediumPriorityTasks}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'priority-low' ? 'active' : ''}`}
              onClick={() => setDetailView('priority-low')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Nizka priorita
              </span>
              <span className="stat-value">{lowPriorityTasks}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa stavu kontaktu</h4>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'new' ? 'active' : ''}`}
              onClick={() => setDetailView('new')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#3B82F6' }}></span>
                Nový
              </span>
              <span className="stat-value">{newContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'active' ? 'active' : ''}`}
              onClick={() => setDetailView('active')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Aktívny
              </span>
              <span className="stat-value">{activeContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'completed-contacts' ? 'active' : ''}`}
              onClick={() => setDetailView('completed-contacts')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Dokončený
              </span>
              <span className="stat-value">{completedContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'cancelled' ? 'active' : ''}`}
              onClick={() => setDetailView('cancelled')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zrušený
              </span>
              <span className="stat-value">{cancelledContacts}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Správy</h4>
            <div
              className={`stat-item clickable ${detailView === 'messages-all' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-all')}
            >
              <span className="stat-label">Celkom správ</span>
              <span className="stat-value">{totalReceived}</span>
            </div>

            <h4 style={{ marginTop: '12px', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>Podľa stavu</h4>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'messages-pending' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-pending')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#F59E0B' }}></span>
                Čaká
              </span>
              <span className="stat-value">{pendingMessages}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'messages-approved' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-approved')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Schválené
              </span>
              <span className="stat-value">{approvedMessages}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'messages-rejected' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-rejected')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zamietnuté
              </span>
              <span className="stat-value">{rejectedMessages}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'messages-commented' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-commented')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Komentované
              </span>
              <span className="stat-value">{commentedMessages}</span>
            </div>

            <h4 style={{ marginTop: '12px', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>Podľa typu</h4>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'messages-poll' ? 'active' : ''}`}
              onClick={() => setDetailView('messages-poll')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EC4899' }}></span>
                Ankety
              </span>
              <span className="stat-value">{pollMessages}</span>
            </div>
          </div>

          <div className="quick-actions">
            <h3>Rýchle akcie</h3>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/crm')}
              style={{ width: '100%', marginBottom: '8px' }}
            >
              + Nový kontakt
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate('/tasks')}
              style={{ width: '100%', marginBottom: '8px' }}
            >
              + Nový projekt
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate('/messages')}
              style={{ width: '100%' }}
            >
              + Nová správa
            </button>
          </div>
        </aside>

        <main className="crm-main">
          {loading ? (
            <div className="loading">Načítavam...</div>
          ) : detailView && detailData ? (
            /* Detail View */
            <div className="dashboard-detail-view">
              <div className="detail-header">
                <button className="btn-back" onClick={closeDetailView}>
                  ← Spat
                </button>
                <h2>{detailData.title} ({detailData.items.length})</h2>
              </div>

              {detailData.type === 'messages' && (
                <>
                  {/* Tab toggle: Prijaté / Odoslané */}
                  <div style={{ display: 'flex', gap: '0', marginBottom: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '3px', border: '1px solid var(--border-color)' }}>
                    <button
                      onClick={() => setMessageTab('received')}
                      style={{
                        flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                        borderRadius: 'calc(var(--radius-md) - 2px)',
                        background: messageTab === 'received' ? 'var(--accent-color)' : 'transparent',
                        color: messageTab === 'received' ? 'white' : 'var(--text-secondary)',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      📥 Prijaté
                    </button>
                    <button
                      onClick={() => setMessageTab('sent')}
                      style={{
                        flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: 600,
                        borderRadius: 'calc(var(--radius-md) - 2px)',
                        background: messageTab === 'sent' ? 'var(--accent-color)' : 'transparent',
                        color: messageTab === 'sent' ? 'white' : 'var(--text-secondary)',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      📤 Odoslané
                    </button>
                  </div>
                  {/* Status filter buttons */}
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                    {['all', 'pending', 'approved', 'rejected', 'commented'].map(s => {
                      const labels = { all: 'Všetky', pending: 'Čaká', approved: 'Schválené', rejected: 'Zamietnuté', commented: 'Komentované' };
                      const isActive = detailView === `messages-${s}`;
                      return (
                        <button
                          key={s}
                          onClick={() => setDetailView(`messages-${s}`)}
                          style={{
                            padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)',
                            background: isActive ? 'var(--accent-color)' : 'var(--bg-card)',
                            color: isActive ? 'white' : 'var(--text-secondary)',
                            cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0
                          }}
                        >
                          {labels[s]}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {detailData.items.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📋</div>
                  <h3>Žiadne položky</h3>
                </div>
              ) : detailData.type === 'contacts' ? (
                <div className="detail-list">
                  {detailData.items.map(contact => {
                    const contactTasks = getContactTasks(contact);
                    const completedContactTasks = contactTasks.filter(t => t.completed).length;
                    return (
                      <div
                        key={contact.id}
                        className="detail-item contact-detail-item"
                        onClick={() => openContactTasks(contact)}
                      >
                        <div
                          className="contact-avatar"
                          style={{ backgroundColor: getStatusColor(contact.status) }}
                        >
                          {contact.name ? contact.name.charAt(0).toUpperCase() : '?'}
                        </div>
                        <div className="detail-item-content">
                          <div className="detail-item-title">{contact.name || 'Bez mena'}</div>
                          <div className="detail-item-meta">
                            <span
                              className="status-badge"
                              style={{ backgroundColor: getStatusColor(contact.status) }}
                            >
                              {getStatusLabel(contact.status)}
                            </span>
                            {contact.company && (
                              <span className="meta-text">{contact.company}</span>
                            )}
                            {contact.email && (
                              <span className="meta-text">{contact.email}</span>
                            )}
                          </div>
                        </div>
                        {contactTasks.length > 0 && (
                          <div className="detail-item-badge">
                            {completedContactTasks}/{contactTasks.length} projektov
                          </div>
                        )}
                        <div className="detail-item-arrow">→</div>
                      </div>
                    );
                  })}
                </div>
              ) : detailData.type === 'messages' ? (
                <div className="detail-list">
                  {detailData.items.map(msg => {
                    const sColors = { pending: '#F59E0B', approved: '#10B981', rejected: '#EF4444', commented: '#6366F1' };
                    const sIcons = { pending: '🕐', approved: '✅', rejected: '❌', commented: '💬' };
                    return (
                    <div
                      key={msg.id}
                      className={`detail-item message-detail-item ${msg.status === 'pending' ? 'unread' : ''}`}
                      onClick={() => navigate(`/messages?tab=${messageTab}&highlight=${msg.id || msg._id}`)}
                    >
                      <div
                        className="contact-avatar"
                        style={{ backgroundColor: sColors[msg.status] || '#6366F1' }}
                      >
                        {sIcons[msg.status] || '✉'}
                      </div>
                      <div className="detail-item-content">
                        <div className="detail-item-title">{msg.subject || 'Bez predmetu'}</div>
                        <div className="detail-item-meta">
                          <span className="meta-text">
                            {messageTab === 'sent' ? `Komu: ${msg.toUsername || 'Neznámy'}` : `Od: ${msg.fromUsername || 'Neznámy'}`}
                          </span>
                          <span className="meta-text">
                            {new Date(msg.createdAt).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {msg.attachment && <span className="meta-text">📎 Príloha</span>}
                        </div>
                        {msg.body && (
                          <div className="detail-item-description" style={{ marginTop: '4px' }}>
                            {msg.body.length > 100 ? msg.body.substring(0, 100) + '...' : msg.body}
                          </div>
                        )}
                      </div>
                      <div className="detail-item-arrow">→</div>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="detail-list">
                  {detailData.items.map(task => (
                    <div
                      key={task.id}
                      className={`detail-item task-detail-item ${task.completed ? 'completed' : ''} ${expandedTask === task.id ? 'expanded' : ''}`}
                      onClick={() => editingTask !== task.id && setExpandedTask(expandedTask === task.id ? null : task.id)}
                      style={{ cursor: editingTask === task.id ? 'default' : 'pointer' }}
                    >
                      {editingTask === task.id ? (
                        /* Edit mode */
                        <div className="task-edit-inline" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editForm.title}
                            onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                            className="form-input"
                            placeholder="Názov projekty"
                            autoFocus
                          />
                          <textarea
                            value={editForm.description}
                            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                            className="form-input"
                            placeholder="Popis"
                            rows={2}
                          />
                          <div className="task-edit-row">
                            <input
                              type="date"
                              value={editForm.dueDate}
                              onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })}
                              className="form-input"
                            />
                            <select
                              value={editForm.priority}
                              onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}
                              className="form-input"
                            >
                              <option value="low">Nízka</option>
                              <option value="medium">Stredná</option>
                              <option value="high">Vysoká</option>
                            </select>
                          </div>
                          <div className="task-edit-actions">
                            <button onClick={() => saveTask(task)} className="btn btn-primary btn-sm">Uložiť</button>
                            <button onClick={cancelEditTask} className="btn btn-secondary btn-sm">Zrušiť</button>
                          </div>
                        </div>
                      ) : (
                        /* View mode */
                        <>
                          <div
                            className="task-checkbox"
                            onClick={(e) => { e.stopPropagation(); toggleTaskComplete(task); }}
                            style={{
                              borderColor: getPriorityColor(task.priority),
                              backgroundColor: task.completed ? getPriorityColor(task.priority) : 'transparent'
                            }}
                          >
                            {task.completed && '✓'}
                          </div>
                          <div className="detail-item-content">
                            <div className="detail-item-title">{task.title}</div>
                            <div className="detail-item-meta">
                              <span
                                className="priority-badge"
                                style={{ backgroundColor: getPriorityColor(task.priority) }}
                              >
                                {getPriorityLabel(task.priority)}
                              </span>
                              {getContactNames(task).length > 0 && (
                                <span className="contact-badge">👤 {getContactNames(task).join(', ')}</span>
                              )}
                              {task.dueDate && (
                                <span className={`date-badge ${getDueDateClass(task.dueDate, task.completed)}`}>
                                  📅 {new Date(task.dueDate).toLocaleDateString('sk-SK')}
                                </span>
                              )}
                            </div>
                            {task.description && expandedTask === task.id && (
                              <div className="detail-item-description">{task.description}</div>
                            )}
                          </div>
                          <div className="task-item-actions">
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditTask(task); }}
                              className="btn-icon"
                              title="Upraviť"
                            >
                              ✏️
                            </button>
                          </div>
                          {task.subtasks?.length > 0 && expandedTask !== task.id && (
                            <div className="detail-item-badge">
                              {countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total}
                            </div>
                          )}
                          {/* Subtasks list when expanded */}
                          {expandedTask === task.id && task.subtasks?.length > 0 && (
                            <div className="dashboard-subtasks-container">
                              <div className="subtasks-header">
                                Úlohy ({countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total})
                              </div>
                              <div className="subtask-tree">
                                {renderDashboardSubtasks(task, task.subtasks, 0)}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Main Dashboard View */
            <div className="dashboard-page">
              <div className="dashboard-header">
                <h2>Vitajte, {user?.username || 'Používateľ'}</h2>
                <p className="dashboard-subtitle">Prehľad vašich kontaktov a projektov</p>
              </div>

              <div className="dashboard-grid">
                {/* Contacts Section */}
                <div className="dashboard-section" onClick={() => setDetailView('contacts')}>
                  <div className="section-header">
                    <h3>Kontakty ({contacts.length})</h3>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={(e) => { e.stopPropagation(); navigate('/crm'); }}
                    >
                      Zobraziť všetky
                    </button>
                  </div>

                  {contacts.length === 0 ? (
                    <div className="empty-state-small">
                      <p>Žiadne kontakty</p>
                    </div>
                  ) : (
                    <div className="dashboard-contacts-list">
                      {sortContacts(contacts).slice(0, 5).map(contact => {
                        const contactTasks = getContactTasks(contact);
                        const completedContactTasks = contactTasks.filter(t => t.completed).length;

                        return (
                          <div
                            key={contact.id}
                            className="dashboard-contact-item"
                            onClick={(e) => { e.stopPropagation(); openContactTasks(contact); }}
                          >
                            <div
                              className="contact-avatar-sm"
                              style={{ backgroundColor: getStatusColor(contact.status) }}
                            >
                              {contact.name ? contact.name.charAt(0).toUpperCase() : '?'}
                            </div>
                            <div className="dashboard-contact-info">
                              <div className="dashboard-contact-name">{contact.name || 'Bez mena'}</div>
                              <div className="dashboard-contact-meta">
                                <span
                                  className="status-badge-sm"
                                  style={{ backgroundColor: getStatusColor(contact.status) }}
                                >
                                  {getStatusLabel(contact.status)}
                                </span>
                                {contact.company && (
                                  <span className="company-text">{contact.company}</span>
                                )}
                              </div>
                            </div>
                            {contactTasks.length > 0 && (
                              <div className="dashboard-contact-tasks">
                                <span className="task-progress">
                                  {completedContactTasks}/{contactTasks.length}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {contacts.length > 5 && (
                        <div className="show-more">
                          + {contacts.length - 5} ďalších kontaktov
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Tasks Section */}
                <div className="dashboard-section" onClick={() => setDetailView('pending')}>
                  <div className="section-header">
                    <h3>Projekty ({tasks.length})</h3>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={(e) => { e.stopPropagation(); navigate('/tasks'); }}
                    >
                      Zobraziť všetky
                    </button>
                  </div>

                  {tasks.length === 0 ? (
                    <div className="empty-state-small">
                      <p>Žiadne projekty</p>
                    </div>
                  ) : (
                    <div className="dashboard-tasks-list">
                      {[...tasks].filter(t => !t.completed).sort((a, b) => {
                        const pri = { high: 0, medium: 1, low: 2 };
                        return (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
                      }).slice(0, 5).map(task => (
                        <div
                          key={task.id}
                          className="dashboard-task-item clickable-task"
                          onClick={(e) => { e.stopPropagation(); navigate('/tasks', { state: { highlightTaskId: task.id } }); }}
                        >
                          <div
                            className="task-priority-indicator"
                            style={{ backgroundColor: getPriorityColor(task.priority) }}
                          />
                          <div className="dashboard-task-info">
                            <div className="dashboard-task-title">{task.title}</div>
                            <div className="dashboard-task-meta">
                              <span
                                className="priority-badge-sm"
                                style={{ backgroundColor: getPriorityColor(task.priority) }}
                              >
                                {getPriorityLabel(task.priority)}
                              </span>
                              {getContactNames(task).length > 0 && (
                                <span className="contact-link-badge">
                                  {getContactNames(task).join(', ')}
                                </span>
                              )}
                              {task.dueDate && (
                                <span className={`due-date-badge ${getDueDateClass(task.dueDate, task.completed)}`}>
                                  {new Date(task.dueDate).toLocaleDateString('sk-SK')}
                                </span>
                              )}
                            </div>
                          </div>
                          {task.subtasks?.length > 0 && (
                            <div className="subtask-indicator">
                              {task.subtasks.filter(s => s.completed).length}/{task.subtasks.length}
                            </div>
                          )}
                        </div>
                      ))}
                      {tasks.filter(t => !t.completed).length > 5 && (
                        <div className="show-more">
                          + {tasks.filter(t => !t.completed).length - 5} ďalších projektov
                        </div>
                      )}

                      {/* Completed tasks summary */}
                      {completedTasks > 0 && (
                        <div
                          className="completed-summary"
                          onClick={(e) => { e.stopPropagation(); setDetailView('completed'); }}
                        >
                          {completedTasks} splnených projektov
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {/* Messages Section */}
                <div className="dashboard-section" onClick={() => setDetailView('messages-all')}>
                <div className="section-header">
                  <h3>Správy ({totalReceived + totalSent})</h3>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => { e.stopPropagation(); navigate('/messages'); }}
                  >
                    Zobraziť všetky
                  </button>
                </div>

                {totalReceived === 0 && totalSent === 0 ? (
                  <div className="empty-state-small">
                    <p>Žiadne správy</p>
                  </div>
                ) : (
                  <div className="dashboard-contacts-list">
                    {[
                      ...messages.received.map(m => ({ ...m, _dir: 'received' })),
                      ...messages.sent.map(m => ({ ...m, _dir: 'sent' }))
                    ]
                      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                      .slice(0, 5)
                      .map(msg => {
                        const isSent = msg._dir === 'sent';
                        const personName = isSent ? (msg.toUsername || 'Neznámy') : (msg.fromUsername || 'Neznámy');
                        const initial = personName.charAt(0).toUpperCase();
                        const statusColors = { pending: '#F59E0B', approved: '#10B981', rejected: '#EF4444', commented: '#6366F1' };
                        const statusLabels = { pending: 'Čaká', approved: 'Schválené', rejected: 'Zamietnuté', commented: 'Komentované' };
                        const statusColor = statusColors[msg.status] || '#6366F1';
                        const avatarColor = statusColor;

                        return (
                          <div
                            key={msg.id}
                            className="dashboard-contact-item"
                            onClick={(e) => { e.stopPropagation(); navigate(`/messages?tab=${isSent ? 'sent' : 'received'}&highlight=${msg.id || msg._id}`); }}
                          >
                            <div
                              className="contact-avatar-sm"
                              style={{ backgroundColor: avatarColor }}
                            >
                              {initial}
                            </div>
                            <div className="dashboard-contact-info">
                              <div className="dashboard-contact-name">
                                {msg.subject || 'Bez predmetu'}
                                {msg.status === 'pending' && (
                                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#F59E0B', marginLeft: 6, verticalAlign: 'middle' }} />
                                )}
                              </div>
                              <div className="dashboard-contact-meta">
                                <span
                                  className="status-badge-sm"
                                  style={{ backgroundColor: statusColor }}
                                >
                                  {statusLabels[msg.status] || msg.status}
                                </span>
                                <span className="company-text">{isSent ? `Pre: ${personName}` : `Od: ${personName}`}</span>
                                <span className="company-text" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                  {new Date(msg.createdAt).toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                </span>
                                {msg.attachment && <span>📎</span>}
                              </div>
                              {msg.body && (
                                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {msg.body.length > 80 ? msg.body.substring(0, 80) + '...' : msg.body}
                                </div>
                              )}
                            </div>
                            {msg.comments?.length > 0 && (
                              <div className="dashboard-contact-tasks">
                                <span className="task-progress">{msg.comments.length} 💬</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    {(totalReceived + totalSent) > 5 && (
                      <div className="show-more">
                        + {(totalReceived + totalSent) - 5} ďalších správ
                      </div>
                    )}
                  </div>
                )}
              </div>

                {/* Recent Activity - Contacts with tasks */}
                <div className="dashboard-section full-width">
                <div className="section-header">
                  <h3>Kontakty s projektami</h3>
                </div>
                <div className="contacts-with-tasks">
                  {contacts
                    .filter(c => getContactTasks(c).length > 0)
                    .slice(0, 5)
                    .map(contact => {
                      const contactTasks = getContactTasks(contact);
                      return (
                        <div
                          key={contact.id}
                          className="contact-tasks-card"
                          onClick={() => openContactTasks(contact)}
                        >
                          <div className="contact-tasks-header">
                            <div
                              className="contact-avatar-sm"
                              style={{ backgroundColor: getStatusColor(contact.status) }}
                            >
                              {contact.name ? contact.name.charAt(0).toUpperCase() : '?'}
                            </div>
                            <div className="contact-tasks-name">{contact.name || 'Bez mena'}</div>
                            <span className="tasks-badge">
                              {contactTasks.filter(t => t.completed).length}/{contactTasks.length} projektov
                            </span>
                          </div>
                          <div className="contact-tasks-list">
                            {contactTasks.slice(0, 3).map(task => (
                              <div
                                key={`${task.source}-${task.id}`}
                                className={`mini-task ${task.completed ? 'completed' : ''}`}
                              >
                                <span className="mini-task-check">{task.completed ? '✓' : '○'}</span>
                                <span className="mini-task-title">{task.title}</span>
                                {task.source === 'global' && (
                                  <span className="mini-task-source">z Projektov</span>
                                )}
                              </div>
                            ))}
                            {contactTasks.length > 3 && (
                              <div className="mini-task more">
                                + {contactTasks.length - 3} ďalších
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  {contacts.filter(c => getContactTasks(c).length > 0).length === 0 && (
                    <div className="empty-state-small">
                      <p>Žiadne kontakty s projektami</p>
                    </div>
                  )}
                </div>
              </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Help Guide */}
      <HelpGuide
        section="dashboard"
        title="Vitajte na Dashboard"
        tips={dashboardHelpTips}
      />
    </div>
  );
}

export default Dashboard;
