import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate } from 'react-router-dom';
import UserMenu from '../components/UserMenu';

function Tasks() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [expandedTask, setExpandedTask] = useState(null);
  const { socket, isConnected } = useSocket();

  // Form states
  const [newTaskForm, setNewTaskForm] = useState({
    title: '',
    description: '',
    dueDate: '',
    priority: 'medium',
    contactId: ''
  });

  // Edit states
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  useEffect(() => {
    fetchTasks();
    fetchContacts();
  }, []);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleTaskCreated = (task) => {
      setTasks(prev => [...prev, task]);
    };

    const handleTaskUpdated = (updatedTask) => {
      setTasks(prev => prev.map(t =>
        t.id === updatedTask.id ? updatedTask : t
      ));
      setSelectedTask(prev =>
        prev?.id === updatedTask.id ? updatedTask : prev
      );
    };

    const handleTaskDeleted = ({ id }) => {
      setTasks(prev => prev.filter(t => t.id !== id));
      setSelectedTask(prev => prev?.id === id ? null : prev);
    };

    socket.on('task-created', handleTaskCreated);
    socket.on('task-updated', handleTaskUpdated);
    socket.on('task-deleted', handleTaskDeleted);

    return () => {
      socket.off('task-created', handleTaskCreated);
      socket.off('task-updated', handleTaskUpdated);
      socket.off('task-deleted', handleTaskDeleted);
    };
  }, [socket, isConnected]);

  const fetchTasks = async () => {
    try {
      const res = await axios.get('/api/tasks');
      setTasks(res.data);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchContacts = async () => {
    try {
      const res = await axios.get('/api/contacts');
      setContacts(res.data);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    }
  };

  const refreshTask = async (taskId) => {
    try {
      const res = await axios.get(`/api/tasks/${taskId}`);
      setTasks(prev => prev.map(t => t.id === taskId ? res.data : t));
      if (selectedTask?.id === taskId) {
        setSelectedTask(res.data);
      }
    } catch (error) {
      console.error('Failed to refresh task:', error);
    }
  };

  const createTask = async (e) => {
    e.preventDefault();
    if (!newTaskForm.title.trim()) return;

    try {
      await axios.post('/api/tasks', {
        ...newTaskForm,
        contactId: newTaskForm.contactId || null
      });
      setNewTaskForm({
        title: '',
        description: '',
        dueDate: '',
        priority: 'medium',
        contactId: ''
      });
      setShowForm(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní úlohy');
    }
  };

  const toggleTask = async (task) => {
    try {
      await axios.put(`/api/tasks/${task.id}`, {
        completed: !task.completed,
        source: task.source
      });
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (task) => {
    if (!window.confirm('Vymazať túto úlohu?')) return;
    try {
      await axios.delete(`/api/tasks/${task.id}?source=${task.source || 'global'}`);
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const startEditTask = (task) => {
    setEditingTask(task.id);
    setEditForm({
      title: task.title,
      description: task.description || '',
      dueDate: task.dueDate || '',
      priority: task.priority || 'medium',
      contactId: task.contactId || '',
      source: task.source
    });
  };

  const saveTask = async (taskId) => {
    try {
      await axios.put(`/api/tasks/${taskId}`, {
        ...editForm,
        contactId: editForm.contactId || null
      });
      setEditingTask(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní úlohy');
    }
  };

  // Subtask functions - now with recursive support
  const addSubtask = async (e, task, parentSubtaskId = null) => {
    e.preventDefault();
    const inputKey = parentSubtaskId || task.id;
    const subtaskTitle = subtaskInputs[inputKey] || '';
    if (!subtaskTitle.trim()) return;

    try {
      await axios.post(`/api/tasks/${task.id}/subtasks`, {
        title: subtaskTitle,
        source: task.source,
        parentSubtaskId: parentSubtaskId
      });
      setSubtaskInputs(prev => ({ ...prev, [inputKey]: '' }));
      await fetchTasks();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytvarani podulohy');
    }
  };

  const toggleSubtask = async (task, subtaskId, completed) => {
    try {
      await axios.put(`/api/tasks/${task.id}/subtasks/${subtaskId}`, {
        completed: !completed,
        source: task.source
      });
      await fetchTasks();
    } catch (error) {
      console.error('Failed to toggle subtask:', error);
    }
  };

  const deleteSubtask = async (task, subtaskId) => {
    try {
      await axios.delete(`/api/tasks/${task.id}/subtasks/${subtaskId}?source=${task.source || 'global'}`);
      await fetchTasks();
    } catch (error) {
      console.error('Failed to delete subtask:', error);
    }
  };

  const startEditSubtask = (task, subtask) => {
    setEditingSubtask({ taskId: task.id, subtaskId: subtask.id, source: task.source });
    setEditSubtaskTitle(subtask.title);
  };

  const saveSubtask = async (task, subtaskId) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      await axios.put(`/api/tasks/${task.id}/subtasks/${subtaskId}`, {
        title: editSubtaskTitle,
        source: task.source
      });
      setEditingSubtask(null);
      setEditSubtaskTitle('');
      await fetchTasks();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladani podulohy');
    }
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setEditSubtaskTitle('');
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

  // Recursive subtask renderer
  const renderSubtasks = (task, subtasks, depth = 0) => {
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
              onChange={() => toggleSubtask(task, subtask.id, subtask.completed)}
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
                      saveSubtask(task, subtask.id);
                    } else if (e.key === 'Escape') {
                      cancelEditSubtask();
                    }
                  }}
                />
                <button onClick={() => saveSubtask(task, subtask.id)} className="btn-icon-sm btn-save" title="Ulozit">✓</button>
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
                  <button onClick={() => deleteSubtask(task, subtask.id)} className="btn-icon-sm" title="Vymazat">×</button>
                </div>
              </>
            )}
          </div>

          {/* Nested subtasks */}
          {isExpanded && hasChildren && (
            <div className="subtask-children">
              {renderSubtasks(task, subtask.subtasks, depth + 1)}
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
      case 'high': return 'Vysoká';
      case 'medium': return 'Stredná';
      case 'low': return 'Nízka';
      default: return priority;
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('sk-SK');
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'completed') return t.completed;
    if (filter === 'active') return !t.completed;
    if (filter === 'high') return t.priority === 'high';
    if (filter === 'with-contact') return t.contactId;
    return true;
  });

  const completedCount = tasks.filter(t => t.completed).length;

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
            onClick={() => navigate('/crm')}
          >
            Kontakty
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
            + Nová úloha
          </button>

          <div className="filter-section">
            <h3>Filter</h3>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="filter-select"
            >
              <option value="all">Všetky ({tasks.length})</option>
              <option value="active">Aktívne ({tasks.length - completedCount})</option>
              <option value="completed">Dokončené ({completedCount})</option>
              <option value="high">Vysoká priorita</option>
              <option value="with-contact">S kontaktom</option>
            </select>
          </div>

          <div className="task-stats">
            <div className="stat-item">
              <span className="stat-label">Celkom</span>
              <span className="stat-value">{tasks.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Dokončené</span>
              <span className="stat-value">{completedCount}</span>
            </div>
          </div>
        </aside>

        <main className="crm-main">
          {showForm ? (
            <div className="contact-form-container">
              <h2>Nová úloha</h2>
              <form onSubmit={createTask} className="contact-form">
                <div className="contact-form-grid">
                  <div className="form-group full-width">
                    <label>Názov *</label>
                    <input
                      type="text"
                      value={newTaskForm.title}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, title: e.target.value })}
                      placeholder="Názov úlohy"
                      className="form-input"
                      required
                    />
                  </div>
                  <div className="form-group full-width">
                    <label>Popis</label>
                    <textarea
                      value={newTaskForm.description}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, description: e.target.value })}
                      placeholder="Popis úlohy..."
                      className="form-input"
                      rows={3}
                    />
                  </div>
                  <div className="form-group">
                    <label>Termín</label>
                    <input
                      type="date"
                      value={newTaskForm.dueDate}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, dueDate: e.target.value })}
                      className="form-input"
                    />
                  </div>
                  <div className="form-group">
                    <label>Priorita</label>
                    <select
                      value={newTaskForm.priority}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, priority: e.target.value })}
                      className="form-input"
                    >
                      <option value="low">Nízka</option>
                      <option value="medium">Stredná</option>
                      <option value="high">Vysoká</option>
                    </select>
                  </div>
                  <div className="form-group full-width">
                    <label>Priradiť ku kontaktu</label>
                    <select
                      value={newTaskForm.contactId}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, contactId: e.target.value })}
                      className="form-input"
                    >
                      <option value="">-- Bez kontaktu --</option>
                      {contacts.map(contact => (
                        <option key={contact.id} value={contact.id}>
                          {contact.name} {contact.company ? `(${contact.company})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                    Zrušiť
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Vytvoriť úlohu
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="tasks-page">
              <div className="tasks-header">
                <h2>Zoznam úloh ({filteredTasks.length})</h2>
              </div>

              {loading ? (
                <div className="loading">Načítavam...</div>
              ) : filteredTasks.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">✓</div>
                  <h2>Žiadne úlohy</h2>
                  <p>Vytvorte novú úlohu kliknutím na tlačidlo vyššie</p>
                </div>
              ) : (
                <div className="tasks-list">
                  {filteredTasks.map(task => (
                    <div key={task.id} className={`task-card ${task.completed ? 'completed' : ''}`}>
                      <div className="task-main">
                        <input
                          type="checkbox"
                          checked={task.completed}
                          onChange={() => toggleTask(task)}
                          className="task-checkbox"
                        />

                        {editingTask === task.id ? (
                          <div className="task-edit-form">
                            <input
                              type="text"
                              value={editForm.title}
                              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                              className="form-input"
                            />
                            <textarea
                              value={editForm.description}
                              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                              placeholder="Popis..."
                              className="form-input"
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
                            <div className="form-group">
                              <label>Kontakt</label>
                              <select
                                value={editForm.contactId}
                                onChange={(e) => setEditForm({ ...editForm, contactId: e.target.value })}
                                className="form-input"
                              >
                                <option value="">-- Bez kontaktu --</option>
                                {contacts.map(contact => (
                                  <option key={contact.id} value={contact.id}>
                                    {contact.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="task-edit-actions">
                              <button onClick={() => saveTask(task.id)} className="btn btn-primary btn-sm">Uložiť</button>
                              <button onClick={() => setEditingTask(null)} className="btn btn-secondary btn-sm">Zrušiť</button>
                            </div>
                          </div>
                        ) : (
                          <div className="task-content" onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}>
                            <div className="task-title">{task.title}</div>
                            <div className="task-meta">
                              <span
                                className="priority-badge"
                                style={{ backgroundColor: getPriorityColor(task.priority) }}
                              >
                                {getPriorityLabel(task.priority)}
                              </span>
                              {task.dueDate && (
                                <span className="due-date">📅 {formatDate(task.dueDate)}</span>
                              )}
                              {task.contactName && (
                                <span className="contact-badge">👤 {task.contactName}</span>
                              )}
                              {task.subtasks?.length > 0 && (
                                <span className="subtask-count">
                                  ✓ {countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {editingTask !== task.id && (
                          <div className="task-actions">
                            <button onClick={() => startEditTask(task)} className="btn-icon" title="Upraviť">✏️</button>
                            <button onClick={() => deleteTask(task)} className="btn-icon" title="Vymazať">🗑️</button>
                          </div>
                        )}
                      </div>

                      {expandedTask === task.id && editingTask !== task.id && (
                        <div className="task-expanded">
                          {task.description && (
                            <div className="task-description">{task.description}</div>
                          )}

                          <div className="subtasks">
                            <div className="subtasks-header">Podulohy</div>

                            <div className="subtask-tree">
                              {renderSubtasks(task, task.subtasks, 0)}
                            </div>

                            <form onSubmit={(e) => addSubtask(e, task)} className="add-subtask-form">
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

export default Tasks;
