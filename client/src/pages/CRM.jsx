import { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import UserMenu from '../components/UserMenu';

function CRM() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [globalTasks, setGlobalTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expandedContact, setExpandedContact] = useState(null);
  const { socket, isConnected } = useSocket();

  // Form states
  const [newContactForm, setNewContactForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    website: '',
    notes: '',
    status: 'new'
  });

  // Edit states
  const [editingContact, setEditingContact] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Task states
  const [taskInputs, setTaskInputs] = useState({});
  const [editingTask, setEditingTask] = useState(null);
  const [editTaskTitle, setEditTaskTitle] = useState('');

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [expandedTasks, setExpandedTasks] = useState({});
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  useEffect(() => {
    fetchContacts();
    fetchGlobalTasks();
  }, []);

  // Get all tasks for a contact (embedded + global assigned)
  const getContactTasks = (contact) => {
    const embeddedTasks = (contact.tasks || []).map(t => ({
      ...t,
      source: 'contact',
      contactId: contact.id  // Add contactId for API calls
    }));
    const assignedGlobalTasks = globalTasks
      .filter(t => t.contactId === contact.id && t.source === 'global')
      .map(t => ({ ...t, source: 'global' }));
    return [...embeddedTasks, ...assignedGlobalTasks];
  };

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleContactCreated = (contact) => {
      setContacts(prev => [...prev, contact]);
    };

    const handleContactUpdated = (updatedContact) => {
      setContacts(prev => prev.map(c =>
        c.id === updatedContact.id ? updatedContact : c
      ));
    };

    const handleContactDeleted = ({ id }) => {
      setContacts(prev => prev.filter(c => c.id !== id));
      if (expandedContact === id) setExpandedContact(null);
    };

    const handleTaskUpdated = (updatedTask) => {
      if (updatedTask.source === 'global') {
        setGlobalTasks(prev => prev.map(t =>
          t.id === updatedTask.id ? updatedTask : t
        ));
      }
    };

    const handleTaskCreated = (task) => {
      if (task.source === 'global' || !task.source) {
        setGlobalTasks(prev => [...prev, { ...task, source: 'global' }]);
      }
    };

    const handleTaskDeleted = ({ id, source }) => {
      if (source === 'global') {
        setGlobalTasks(prev => prev.filter(t => t.id !== id));
      }
    };

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
  }, [socket, isConnected, expandedContact]);

  const fetchContacts = async () => {
    try {
      const res = await axios.get('/api/contacts');
      setContacts(res.data);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchGlobalTasks = async () => {
    try {
      const res = await axios.get('/api/tasks');
      // Filter only global tasks that have contactId
      const globalOnly = res.data.filter(t => t.source === 'global');
      setGlobalTasks(globalOnly);
    } catch (error) {
      console.error('Failed to fetch global tasks:', error);
    }
  };

  const createContact = async (e) => {
    e.preventDefault();
    if (!newContactForm.name.trim()) return;

    try {
      await axios.post('/api/contacts', newContactForm);
      setNewContactForm({
        name: '',
        email: '',
        phone: '',
        company: '',
        website: '',
        notes: '',
        status: 'new'
      });
      setShowForm(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní kontaktu');
    }
  };

  const deleteContact = async (contact) => {
    if (!window.confirm('Vymazať tento kontakt?')) return;
    try {
      await axios.delete(`/api/contacts/${contact.id}`);
    } catch (error) {
      console.error('Failed to delete contact:', error);
    }
  };

  const startEditContact = (contact) => {
    setEditingContact(contact.id);
    setEditForm({
      name: contact.name,
      email: contact.email || '',
      phone: contact.phone || '',
      company: contact.company || '',
      website: contact.website || '',
      notes: contact.notes || '',
      status: contact.status || 'new'
    });
  };

  const saveContact = async (contactId) => {
    try {
      await axios.put(`/api/contacts/${contactId}`, editForm);
      setEditingContact(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní kontaktu');
    }
  };

  // Task functions
  const addTask = async (e, contact) => {
    e.preventDefault();
    const taskTitle = taskInputs[contact.id] || '';
    if (!taskTitle.trim()) return;

    try {
      await axios.post(`/api/contacts/${contact.id}/tasks`, { title: taskTitle });
      setTaskInputs(prev => ({ ...prev, [contact.id]: '' }));
      await fetchContacts();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní úlohy');
    }
  };

  const toggleTask = async (contact, task) => {
    try {
      if (task.source === 'global') {
        // Global task - use /api/tasks endpoint
        await axios.put(`/api/tasks/${task.id}`, {
          completed: !task.completed,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await axios.put(`/api/contacts/${contact.id}/tasks/${task.id}`, {
          completed: !task.completed
        });
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (contact, task) => {
    try {
      if (task.source === 'global') {
        // Global task - use /api/tasks endpoint
        await axios.delete(`/api/tasks/${task.id}?source=global`);
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await axios.delete(`/api/contacts/${contact.id}/tasks/${task.id}`);
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const startEditTask = (contact, task) => {
    setEditingTask({ contactId: contact.id, taskId: task.id, source: task.source });
    setEditTaskTitle(task.title);
  };

  const saveTask = async (contact, task) => {
    if (!editTaskTitle.trim()) return;
    try {
      if (task.source === 'global') {
        // Global task
        await axios.put(`/api/tasks/${task.id}`, {
          title: editTaskTitle,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await axios.put(`/api/contacts/${contact.id}/tasks/${task.id}`, {
          title: editTaskTitle
        });
        await fetchContacts();
      }
      setEditingTask(null);
      setEditTaskTitle('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní úlohy');
    }
  };

  const cancelEditTask = () => {
    setEditingTask(null);
    setEditTaskTitle('');
  };

  // Subtask functions - with recursive support
  const toggleTaskExpanded = (taskId) => {
    setExpandedTasks(prev => ({
      ...prev,
      [taskId]: !prev[taskId]
    }));
  };

  const toggleSubtaskExpanded = (subtaskId) => {
    setExpandedSubtasks(prev => ({
      ...prev,
      [subtaskId]: !prev[subtaskId]
    }));
  };

  // Count all subtasks recursively
  const countSubtasksRecursive = (subtasks) => {
    if (!subtasks || subtasks.length === 0) return { total: 0, completed: 0 };
    let total = 0;
    let completed = 0;
    for (const subtask of subtasks) {
      total++;
      if (subtask.completed) completed++;
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        const childCounts = countSubtasksRecursive(subtask.subtasks);
        total += childCounts.total;
        completed += childCounts.completed;
      }
    }
    return { total, completed };
  };

  const addSubtask = async (e, task, parentSubtaskId = null) => {
    e.preventDefault();
    const inputKey = parentSubtaskId || task.id;
    const subtaskTitle = subtaskInputs[inputKey] || '';
    if (!subtaskTitle.trim()) return;

    try {
      if (task.source === 'global') {
        await axios.post(`/api/tasks/${task.id}/subtasks`, {
          title: subtaskTitle,
          source: 'global',
          parentSubtaskId: parentSubtaskId
        });
        await fetchGlobalTasks();
      } else {
        await axios.post(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks`, {
          title: subtaskTitle,
          parentSubtaskId: parentSubtaskId
        });
        await fetchContacts();
      }
      setSubtaskInputs(prev => ({ ...prev, [inputKey]: '' }));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytvarani podulohy');
    }
  };

  const toggleSubtask = async (task, subtask) => {
    try {
      if (task.source === 'global') {
        await axios.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          completed: !subtask.completed,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        await axios.put(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`, {
          completed: !subtask.completed
        });
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to toggle subtask:', error);
    }
  };

  const deleteSubtask = async (task, subtask) => {
    try {
      if (task.source === 'global') {
        await axios.delete(`/api/tasks/${task.id}/subtasks/${subtask.id}?source=global`);
        await fetchGlobalTasks();
      } else {
        await axios.delete(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`);
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to delete subtask:', error);
    }
  };

  const startEditSubtask = (task, subtask) => {
    setEditingSubtask({ taskId: task.id, subtaskId: subtask.id, source: task.source });
    setEditSubtaskTitle(subtask.title);
  };

  const saveSubtask = async (task, subtask) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      if (task.source === 'global') {
        await axios.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          title: editSubtaskTitle,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        await axios.put(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`, {
          title: editSubtaskTitle
        });
        await fetchContacts();
      }
      setEditingSubtask(null);
      setEditSubtaskTitle('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladani podulohy');
    }
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setEditSubtaskTitle('');
  };

  // Recursive subtask renderer for CRM
  const renderCRMSubtasks = (task, subtasks, depth = 0) => {
    if (!subtasks || subtasks.length === 0) return null;

    return subtasks.map(subtask => {
      const hasChildren = subtask.subtasks && subtask.subtasks.length > 0;
      const isExpanded = expandedSubtasks[subtask.id];
      const childCounts = hasChildren ? countSubtasksRecursive(subtask.subtasks) : { total: 0, completed: 0 };

      return (
        <div key={subtask.id} className="subtask-tree-item" style={{ marginLeft: depth * 16 }}>
          <div className={`subtask-item ${subtask.completed ? 'completed' : ''}`}>
            <input
              type="checkbox"
              checked={subtask.completed}
              onChange={() => toggleSubtask(task, subtask)}
              className="task-checkbox"
            />

            {hasChildren && (
              <button
                className="subtask-expand-btn"
                onClick={() => toggleSubtaskExpanded(subtask.id)}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}

            {editingSubtask?.taskId === task.id && editingSubtask?.subtaskId === subtask.id ? (
              <div className="subtask-edit-form">
                <input
                  type="text"
                  value={editSubtaskTitle}
                  onChange={(e) => setEditSubtaskTitle(e.target.value)}
                  className="form-input form-input-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveSubtask(task, subtask);
                    } else if (e.key === 'Escape') {
                      cancelEditSubtask();
                    }
                  }}
                />
                <button onClick={() => saveSubtask(task, subtask)} className="btn-icon-sm btn-save" title="Ulozit">✓</button>
                <button onClick={cancelEditSubtask} className="btn-icon-sm btn-cancel" title="Zrusit">×</button>
              </div>
            ) : (
              <>
                <span
                  className="subtask-title"
                  onDoubleClick={() => startEditSubtask(task, subtask)}
                  title="Dvojklik pre upravu"
                >
                  {subtask.title}
                </span>
                {hasChildren && (
                  <span className="subtask-child-count">
                    ({childCounts.completed}/{childCounts.total})
                  </span>
                )}
                <div className="subtask-actions">
                  <button
                    onClick={() => {
                      setExpandedSubtasks(prev => ({ ...prev, [subtask.id]: true }));
                      setSubtaskInputs(prev => ({ ...prev, [subtask.id]: '' }));
                    }}
                    className="btn-icon-sm btn-add-child"
                    title="Pridat podulohu"
                  >
                    +
                  </button>
                  <button onClick={() => startEditSubtask(task, subtask)} className="btn-icon-sm" title="Upravit">✏️</button>
                  <button onClick={() => deleteSubtask(task, subtask)} className="btn-icon-sm" title="Vymazat">×</button>
                </div>
              </>
            )}
          </div>

          {/* Nested subtasks */}
          {isExpanded && hasChildren && (
            <div className="subtask-children">
              {renderCRMSubtasks(task, subtask.subtasks, depth + 1)}
            </div>
          )}

          {/* Add child subtask form */}
          {isExpanded && subtaskInputs[subtask.id] !== undefined && (
            <form
              onSubmit={(e) => addSubtask(e, task, subtask.id)}
              className="add-subtask-form nested"
              style={{ marginLeft: (depth + 1) * 16 }}
            >
              <input
                type="text"
                value={subtaskInputs[subtask.id] || ''}
                onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                placeholder="Nova poduloha..."
                className="form-input form-input-sm"
                autoFocus
              />
              <button type="submit" className="btn btn-secondary btn-sm">+</button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setSubtaskInputs(prev => {
                  const newInputs = { ...prev };
                  delete newInputs[subtask.id];
                  return newInputs;
                })}
              >
                ×
              </button>
            </form>
          )}
        </div>
      );
    });
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

  const filteredContacts = contacts.filter(c => {
    if (filter === 'all') return true;
    return c.status === filter;
  });

  const statusCounts = {
    all: contacts.length,
    new: contacts.filter(c => c.status === 'new').length,
    active: contacts.filter(c => c.status === 'active').length,
    completed: contacts.filter(c => c.status === 'completed').length,
    cancelled: contacts.filter(c => c.status === 'cancelled').length
  };

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
          <h1 className="header-title-link" onClick={() => navigate('/')}>Perun CRM</h1>
        </div>
        <div className="crm-header-right">
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/tasks')}
          >
            Úlohy
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
          <button
            className="btn btn-primary add-contact-btn"
            onClick={() => {
              setShowForm(true);
              setSidebarOpen(false);
            }}
          >
            + Nový kontakt
          </button>

          <div className="filter-section">
            <h3>Filter</h3>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="filter-select"
            >
              <option value="all">Všetky ({statusCounts.all})</option>
              <option value="new">Nové ({statusCounts.new})</option>
              <option value="active">Aktívne ({statusCounts.active})</option>
              <option value="completed">Dokončené ({statusCounts.completed})</option>
              <option value="cancelled">Zrušené ({statusCounts.cancelled})</option>
            </select>
          </div>

          <div className="task-stats">
            <div className="stat-item">
              <span className="stat-label">Celkom</span>
              <span className="stat-value">{contacts.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Aktívne</span>
              <span className="stat-value">{statusCounts.active}</span>
            </div>
          </div>
        </aside>

        <main className="crm-main">
          {showForm ? (
            <div className="contact-form-container">
              <h2>Nový kontakt</h2>
              <form onSubmit={createContact} className="contact-form">
                <div className="contact-form-grid">
                  <div className="form-group">
                    <label>Meno *</label>
                    <input
                      type="text"
                      value={newContactForm.name}
                      onChange={(e) => setNewContactForm({ ...newContactForm, name: e.target.value })}
                      placeholder="Meno kontaktu"
                      className="form-input"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Email</label>
                    <input
                      type="email"
                      value={newContactForm.email}
                      onChange={(e) => setNewContactForm({ ...newContactForm, email: e.target.value })}
                      placeholder="email@example.com"
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Telefón</label>
                    <input
                      type="tel"
                      value={newContactForm.phone}
                      onChange={(e) => setNewContactForm({ ...newContactForm, phone: e.target.value })}
                      placeholder="+421 XXX XXX XXX"
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Firma</label>
                    <input
                      type="text"
                      value={newContactForm.company}
                      onChange={(e) => setNewContactForm({ ...newContactForm, company: e.target.value })}
                      placeholder="Názov firmy"
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Webstránka</label>
                    <input
                      type="url"
                      value={newContactForm.website}
                      onChange={(e) => setNewContactForm({ ...newContactForm, website: e.target.value })}
                      placeholder="https://www.example.sk"
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Stav</label>
                    <select
                      value={newContactForm.status}
                      onChange={(e) => setNewContactForm({ ...newContactForm, status: e.target.value })}
                      className="form-input"
                    >
                      <option value="new">Nový</option>
                      <option value="active">Aktívny</option>
                      <option value="completed">Dokončený</option>
                      <option value="cancelled">Zrušený</option>
                    </select>
                  </div>
                  <div className="form-group full-width">
                    <label>Poznámky</label>
                    <textarea
                      value={newContactForm.notes}
                      onChange={(e) => setNewContactForm({ ...newContactForm, notes: e.target.value })}
                      placeholder="Poznámky ku kontaktu..."
                      className="form-input"
                      rows={3}
                    />
                  </div>
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                    Zrušiť
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Vytvoriť kontakt
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="contacts-page">
              <div className="contacts-header">
                <h2>Zoznam kontaktov ({filteredContacts.length})</h2>
              </div>

              {loading ? (
                <div className="loading">Načítavam...</div>
              ) : filteredContacts.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">👥</div>
                  <h2>Žiadne kontakty</h2>
                  <p>Vytvorte nový kontakt kliknutím na tlačidlo vyššie</p>
                </div>
              ) : (
                <div className="contacts-list">
                  {filteredContacts.map(contact => (
                    <div key={contact.id} className={`contact-card ${expandedContact === contact.id ? 'expanded' : ''}`}>
                      <div className="contact-main">
                        <div
                          className="contact-avatar"
                          style={{ backgroundColor: getStatusColor(contact.status) }}
                        >
                          {contact.name.charAt(0).toUpperCase()}
                        </div>

                        {editingContact === contact.id ? (
                          <div className="contact-edit-form">
                            <input
                              type="text"
                              value={editForm.name}
                              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                              className="form-input"
                              placeholder="Meno"
                            />
                            <div className="contact-edit-row">
                              <input
                                type="email"
                                value={editForm.email}
                                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                                className="form-input"
                                placeholder="Email"
                              />
                              <input
                                type="tel"
                                value={editForm.phone}
                                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                                className="form-input"
                                placeholder="Telefón"
                              />
                            </div>
                            <div className="contact-edit-row">
                              <input
                                type="text"
                                value={editForm.company}
                                onChange={(e) => setEditForm({ ...editForm, company: e.target.value })}
                                className="form-input"
                                placeholder="Firma"
                              />
                              <select
                                value={editForm.status}
                                onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                                className="form-input"
                              >
                                <option value="new">Nový</option>
                                <option value="active">Aktívny</option>
                                <option value="completed">Dokončený</option>
                                <option value="cancelled">Zrušený</option>
                              </select>
                            </div>
                            <input
                              type="url"
                              value={editForm.website}
                              onChange={(e) => setEditForm({ ...editForm, website: e.target.value })}
                              className="form-input"
                              placeholder="Webstránka"
                            />
                            <textarea
                              value={editForm.notes}
                              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                              className="form-input"
                              placeholder="Poznámky"
                              rows={2}
                            />
                            <div className="contact-edit-actions">
                              <button onClick={() => saveContact(contact.id)} className="btn btn-primary btn-sm">Uložiť</button>
                              <button onClick={() => setEditingContact(null)} className="btn btn-secondary btn-sm">Zrušiť</button>
                            </div>
                          </div>
                        ) : (
                          <div className="contact-content" onClick={() => setExpandedContact(expandedContact === contact.id ? null : contact.id)}>
                            <div className="contact-name">{contact.name}</div>
                            <div className="contact-meta">
                              <span
                                className="status-badge"
                                style={{ backgroundColor: getStatusColor(contact.status) }}
                              >
                                {getStatusLabel(contact.status)}
                              </span>
                              {contact.company && (
                                <span className="company-badge">🏢 {contact.company}</span>
                              )}
                              {contact.email && (
                                <span className="email-badge">✉️ {contact.email}</span>
                              )}
                              {(() => {
                                const allTasks = getContactTasks(contact);
                                return allTasks.length > 0 && (
                                  <span className="tasks-count">
                                    ✓ {allTasks.filter(t => t.completed).length}/{allTasks.length}
                                  </span>
                                );
                              })()}
                            </div>
                          </div>
                        )}

                        {editingContact !== contact.id && (
                          <div className="contact-actions">
                            <button onClick={() => startEditContact(contact)} className="btn-icon" title="Upraviť">✏️</button>
                            <button onClick={() => deleteContact(contact)} className="btn-icon" title="Vymazať">🗑️</button>
                          </div>
                        )}
                      </div>

                      {expandedContact === contact.id && editingContact !== contact.id && (
                        <div className="contact-expanded">
                          {/* Contact Details */}
                          <div className="contact-details">
                            {contact.phone && (
                              <div className="detail-item">
                                <span className="detail-label">📞 Telefón:</span>
                                <a href={`tel:${contact.phone}`} className="detail-value">{contact.phone}</a>
                              </div>
                            )}
                            {contact.email && (
                              <div className="detail-item">
                                <span className="detail-label">✉️ Email:</span>
                                <a href={`mailto:${contact.email}`} className="detail-value">{contact.email}</a>
                              </div>
                            )}
                            {contact.website && (
                              <div className="detail-item">
                                <span className="detail-label">🌐 Web:</span>
                                <a href={contact.website} target="_blank" rel="noopener noreferrer" className="detail-value website-link">
                                  {contact.website}
                                </a>
                              </div>
                            )}
                            {contact.notes && (
                              <div className="detail-item">
                                <span className="detail-label">📝 Poznámky:</span>
                                <span className="detail-value">{contact.notes}</span>
                              </div>
                            )}
                          </div>

                          {/* Tasks Section */}
                          <div className="contact-tasks">
                            <div className="tasks-section-header">Úlohy</div>

                            {getContactTasks(contact).map(task => (
                              <div key={`${task.source}-${task.id}`} className={`task-item ${task.completed ? 'completed' : ''} ${task.source === 'global' ? 'global-task' : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={task.completed}
                                  onChange={() => toggleTask(contact, task)}
                                  className="task-checkbox"
                                />
                                {editingTask?.contactId === contact.id && editingTask?.taskId === task.id ? (
                                  <div className="task-edit-inline">
                                    <input
                                      type="text"
                                      value={editTaskTitle}
                                      onChange={(e) => setEditTaskTitle(e.target.value)}
                                      className="form-input form-input-sm"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          saveTask(contact, task);
                                        } else if (e.key === 'Escape') {
                                          cancelEditTask();
                                        }
                                      }}
                                    />
                                    <button
                                      onClick={() => saveTask(contact, task)}
                                      className="btn-icon-sm btn-save"
                                      title="Uložiť"
                                    >
                                      ✓
                                    </button>
                                    <button
                                      onClick={cancelEditTask}
                                      className="btn-icon-sm btn-cancel"
                                      title="Zrušiť"
                                    >
                                      ×
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <span
                                      className="task-title"
                                      onDoubleClick={() => startEditTask(contact, task)}
                                      title="Dvojklik pre úpravu"
                                    >
                                      {task.title}
                                      {task.source === 'global' && <span className="task-source-badge">z Úloh</span>}
                                      {task.subtasks?.length > 0 && (
                                        <span className="subtask-count">
                                          ({countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total})
                                        </span>
                                      )}
                                    </span>
                                    <div className="task-item-actions">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); toggleTaskExpanded(task.id); }}
                                        className="btn-icon-sm"
                                        title={expandedTasks[task.id] ? 'Skryť podúlohy' : 'Zobraziť podúlohy'}
                                      >
                                        {expandedTasks[task.id] ? '▼' : '▶'}
                                      </button>
                                      <button
                                        onClick={() => startEditTask(contact, task)}
                                        className="btn-icon-sm"
                                        title="Upraviť"
                                      >
                                        ✏️
                                      </button>
                                      <button
                                        onClick={() => deleteTask(contact, task)}
                                        className="btn-icon-sm"
                                        title="Vymazať"
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </>
                                )}

                                {/* Subtasks - recursive */}
                                {expandedTasks[task.id] && (
                                  <div className="subtasks-container">
                                    <div className="subtask-tree">
                                      {renderCRMSubtasks({ ...task, contactId: contact.id }, task.subtasks, 0)}
                                    </div>

                                    <form onSubmit={(e) => addSubtask(e, { ...task, contactId: contact.id })} className="add-subtask-inline">
                                      <input
                                        type="text"
                                        value={subtaskInputs[task.id] || ''}
                                        onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                                        placeholder="Pridat podulohu..."
                                        className="form-input form-input-sm"
                                      />
                                      <button type="submit" className="btn btn-secondary btn-sm">+</button>
                                    </form>
                                  </div>
                                )}
                              </div>
                            ))}

                            <form onSubmit={(e) => addTask(e, contact)} className="add-task-inline">
                              <input
                                type="text"
                                value={taskInputs[contact.id] || ''}
                                onChange={(e) => setTaskInputs(prev => ({ ...prev, [contact.id]: e.target.value }))}
                                placeholder="Pridať úlohu..."
                                className="form-input form-input-sm"
                              />
                              <button type="submit" className="btn btn-secondary btn-sm">+</button>
                            </form>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default CRM;
