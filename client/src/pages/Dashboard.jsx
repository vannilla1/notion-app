import { useState, useEffect } from 'react';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate } from 'react-router-dom';
import UserMenu from '../components/UserMenu';

function Dashboard() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { socket, isConnected } = useSocket();

  // Detail view state
  const [detailView, setDetailView] = useState(null); // 'contacts', 'tasks', 'active', 'pending', 'completed', 'contactTasks'
  const [selectedContact, setSelectedContact] = useState(null);

  // Task editing state
  const [expandedTask, setExpandedTask] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [subtaskEditForm, setSubtaskEditForm] = useState({});
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleContactUpdated = () => fetchData();
    const handleContactCreated = () => fetchData();
    const handleContactDeleted = () => fetchData();
    const handleTaskUpdated = () => fetchData();
    const handleTaskCreated = () => fetchData();
    const handleTaskDeleted = () => fetchData();

    socket.on('contact-created', handleContactCreated);
    socket.on('contact-updated', handleContactUpdated);
    socket.on('contact-deleted', handleContactDeleted);
    socket.on('task-updated', handleTaskUpdated);
    socket.on('task-created', handleTaskCreated);
    socket.on('task-deleted', handleTaskDeleted);

    return () => {
      socket.off('contact-created', handleContactCreated);
      socket.off('contact-updated', handleContactUpdated);
      socket.off('contact-deleted', handleContactDeleted);
      socket.off('task-updated', handleTaskUpdated);
      socket.off('task-created', handleTaskCreated);
      socket.off('task-deleted', handleTaskDeleted);
    };
  }, [socket, isConnected]);

  const fetchData = async () => {
    try {
      const [contactsRes, tasksRes] = await Promise.all([
        api.get('/api/contacts'),
        api.get('/api/tasks')
      ]);
      setContacts(contactsRes.data);
      setTasks(tasksRes.data);
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
      case 'new': return 'Novy';
      case 'active': return 'Aktivny';
      case 'completed': return 'Dokonceny';
      case 'cancelled': return 'Zruseny';
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

    if (diffDays < 0) return 'overdue';
    if (diffDays <= 3) return 'due-soon';
    if (diffDays <= 10) return 'due-week';
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

  // Stats
  const activeContacts = contacts.filter(c => c.status === 'active').length;
  const newContacts = contacts.filter(c => c.status === 'new').length;
  const completedContacts = contacts.filter(c => c.status === 'completed').length;
  const cancelledContacts = contacts.filter(c => c.status === 'cancelled').length;
  const pendingTasks = tasks.filter(t => !t.completed).length;
  const completedTasks = tasks.filter(t => t.completed).length;

  // Priority stats
  const lowPriorityTasks = tasks.filter(t => t.priority === 'low' && !t.completed).length;
  const mediumPriorityTasks = tasks.filter(t => t.priority === 'medium' && !t.completed).length;
  const highPriorityTasks = tasks.filter(t => t.priority === 'high' && !t.completed).length;

  // Get items for detail view
  const getDetailItems = () => {
    switch (detailView) {
      case 'contacts':
        return { type: 'contacts', items: contacts, title: 'Vsetky kontakty' };
      case 'active':
        return { type: 'contacts', items: contacts.filter(c => c.status === 'active'), title: 'Aktivne kontakty' };
      case 'new':
        return { type: 'contacts', items: contacts.filter(c => c.status === 'new'), title: 'Nove kontakty' };
      case 'completed-contacts':
        return { type: 'contacts', items: contacts.filter(c => c.status === 'completed'), title: 'Dokoncene kontakty' };
      case 'cancelled':
        return { type: 'contacts', items: contacts.filter(c => c.status === 'cancelled'), title: 'Zrusene kontakty' };
      case 'tasks':
        return { type: 'tasks', items: tasks, title: 'Vsetky ulohy' };
      case 'pending':
        return { type: 'tasks', items: tasks.filter(t => !t.completed), title: 'Nesplnene ulohy' };
      case 'completed':
        return { type: 'tasks', items: tasks.filter(t => t.completed), title: 'Splnene ulohy' };
      case 'contactTasks':
        if (selectedContact) {
          return { type: 'tasks', items: getContactTasks(selectedContact), title: `Ulohy: ${selectedContact.name}` };
        }
        return null;
      case 'priority-low':
        return { type: 'tasks', items: tasks.filter(t => t.priority === 'low' && !t.completed), title: 'Ulohy s nizkou prioritou' };
      case 'priority-medium':
        return { type: 'tasks', items: tasks.filter(t => t.priority === 'medium' && !t.completed), title: 'Ulohy so strednou prioritou' };
      case 'priority-high':
        return { type: 'tasks', items: tasks.filter(t => t.priority === 'high' && !t.completed), title: 'Ulohy s vysokou prioritou' };
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
      alert('Chyba pri ukladaní úlohy');
    }
  };

  const toggleTaskComplete = async (task) => {
    if (!task.completed) {
      if (!window.confirm(`Označiť úlohu "${task.title}" ako dokončenú?`)) return;
    }
    try {
      if (task.source === 'contact' && task.contactId) {
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}`, { completed: !task.completed });
      } else {
        await api.put(`/api/tasks/${task.id}`, { completed: !task.completed, source: task.source });
      }
      await fetchData();
    } catch (error) {
      alert('Chyba pri aktualizácii úlohy');
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
      alert('Chyba pri ukladaní podúlohy');
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
      alert('Chyba pri aktualizácii podúlohy');
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
                  placeholder="Názov podúlohy"
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
          <h1 className="header-title-link active" onClick={closeDetailView}>Perun CRM</h1>
        </div>
        <div className="crm-header-right">
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
            Ulohy
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
            <h3>Prehlad</h3>
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
              <span className="stat-label">Aktivnych</span>
              <span className="stat-value">{activeContacts}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'tasks' ? 'active' : ''}`}
              onClick={() => setDetailView('tasks')}
            >
              <span className="stat-label">Globalnych uloh</span>
              <span className="stat-value">{tasks.length}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'pending' ? 'active' : ''}`}
              onClick={() => setDetailView('pending')}
            >
              <span className="stat-label">Nesplnenych</span>
              <span className="stat-value">{pendingTasks}</span>
            </div>
            <div
              className={`stat-item clickable ${detailView === 'completed' ? 'active' : ''}`}
              onClick={() => setDetailView('completed')}
            >
              <span className="stat-label">Splnenych</span>
              <span className="stat-value">{completedTasks}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podla priority</h4>
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

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podla stavu kontaktu</h4>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'new' ? 'active' : ''}`}
              onClick={() => setDetailView('new')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#3B82F6' }}></span>
                Novy
              </span>
              <span className="stat-value">{newContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'active' ? 'active' : ''}`}
              onClick={() => setDetailView('active')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Aktivny
              </span>
              <span className="stat-value">{activeContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'completed-contacts' ? 'active' : ''}`}
              onClick={() => setDetailView('completed-contacts')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Dokonceny
              </span>
              <span className="stat-value">{completedContacts}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${detailView === 'cancelled' ? 'active' : ''}`}
              onClick={() => setDetailView('cancelled')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zruseny
              </span>
              <span className="stat-value">{cancelledContacts}</span>
            </div>
          </div>

          <div className="quick-actions">
            <h3>Rychle akcie</h3>
            <button
              className="btn btn-primary"
              onClick={() => navigate('/crm')}
              style={{ width: '100%', marginBottom: '8px' }}
            >
              + Novy kontakt
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate('/tasks')}
              style={{ width: '100%' }}
            >
              + Nova uloha
            </button>
          </div>
        </aside>

        <main className="crm-main">
          {loading ? (
            <div className="loading">Nacitavam...</div>
          ) : detailView && detailData ? (
            /* Detail View */
            <div className="dashboard-detail-view">
              <div className="detail-header">
                <button className="btn-back" onClick={closeDetailView}>
                  ← Spat
                </button>
                <h2>{detailData.title} ({detailData.items.length})</h2>
              </div>

              {detailData.items.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📋</div>
                  <h3>Ziadne polozky</h3>
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
                            {completedContactTasks}/{contactTasks.length} uloh
                          </div>
                        )}
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
                            placeholder="Názov úlohy"
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
                                Podúlohy ({countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total})
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
                <h2>Vitajte, {user?.username || 'Pouzivatel'}</h2>
                <p className="dashboard-subtitle">Prehlad vasich kontaktov a uloh</p>
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
                      Zobrazit vsetky
                    </button>
                  </div>

                  {contacts.length === 0 ? (
                    <div className="empty-state-small">
                      <p>Ziadne kontakty</p>
                    </div>
                  ) : (
                    <div className="dashboard-contacts-list">
                      {contacts.slice(0, 5).map(contact => {
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
                          + {contacts.length - 5} dalsich kontaktov
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Tasks Section */}
                <div className="dashboard-section" onClick={() => setDetailView('pending')}>
                  <div className="section-header">
                    <h3>Ulohy ({tasks.length})</h3>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={(e) => { e.stopPropagation(); navigate('/tasks'); }}
                    >
                      Zobrazit vsetky
                    </button>
                  </div>

                  {tasks.length === 0 ? (
                    <div className="empty-state-small">
                      <p>Ziadne ulohy</p>
                    </div>
                  ) : (
                    <div className="dashboard-tasks-list">
                      {tasks.filter(t => !t.completed).slice(0, 5).map(task => (
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
                          + {tasks.filter(t => !t.completed).length - 5} dalsich uloh
                        </div>
                      )}

                      {/* Completed tasks summary */}
                      {completedTasks > 0 && (
                        <div
                          className="completed-summary"
                          onClick={(e) => { e.stopPropagation(); setDetailView('completed'); }}
                        >
                          {completedTasks} splnenych uloh
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Recent Activity - Contacts with tasks */}
              <div className="dashboard-section full-width">
                <div className="section-header">
                  <h3>Kontakty s ulohami</h3>
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
                              {contactTasks.filter(t => t.completed).length}/{contactTasks.length} uloh
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
                                  <span className="mini-task-source">z Uloh</span>
                                )}
                              </div>
                            ))}
                            {contactTasks.length > 3 && (
                              <div className="mini-task more">
                                + {contactTasks.length - 3} dalsich
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  {contacts.filter(c => getContactTasks(c).length > 0).length === 0 && (
                    <div className="empty-state-small">
                      <p>Ziadne kontakty s ulohami</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default Dashboard;
