import { useState, useEffect } from 'react';
import axios from 'axios';
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
        axios.get('/api/contacts'),
        axios.get('/api/tasks')
      ]);
      setContacts(contactsRes.data);
      setTasks(tasksRes.data.filter(t => t.source === 'global'));
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

  // Get all tasks for a contact (embedded + global assigned)
  const getContactTasks = (contact) => {
    const embeddedTasks = (contact.tasks || []).map(t => ({
      ...t,
      source: 'contact'
    }));
    const assignedGlobalTasks = tasks
      .filter(t => t.contactId === contact.id)
      .map(t => ({ ...t, source: 'global' }));
    return [...embeddedTasks, ...assignedGlobalTasks];
  };

  // Get contact name by ID
  const getContactName = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    return contact ? contact.name : null;
  };

  // Stats
  const activeContacts = contacts.filter(c => c.status === 'active').length;
  const pendingTasks = tasks.filter(t => !t.completed).length;
  const completedTasks = tasks.filter(t => t.completed).length;
  const totalContactTasks = contacts.reduce((sum, c) => sum + (c.tasks?.length || 0), 0);

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
          <h1 className="header-title-link active">Perun CRM</h1>
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
            <div className="stat-item">
              <span className="stat-label">Celkom kontaktov</span>
              <span className="stat-value">{contacts.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Aktivnych</span>
              <span className="stat-value">{activeContacts}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Globalnych uloh</span>
              <span className="stat-value">{tasks.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Nesplnenych</span>
              <span className="stat-value">{pendingTasks}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Splnenych</span>
              <span className="stat-value">{completedTasks}</span>
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
          ) : (
            <div className="dashboard-page">
              <div className="dashboard-header">
                <h2>Vitajte, {user?.username || 'Pouzivatel'}</h2>
                <p className="dashboard-subtitle">Prehlad vasich kontaktov a uloh</p>
              </div>

              <div className="dashboard-grid">
                {/* Contacts Section */}
                <div className="dashboard-section">
                  <div className="section-header">
                    <h3>Kontakty ({contacts.length})</h3>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => navigate('/crm')}
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
                      {contacts.slice(0, 10).map(contact => {
                        const contactTasks = getContactTasks(contact);
                        const completedContactTasks = contactTasks.filter(t => t.completed).length;

                        return (
                          <div
                            key={contact.id}
                            className="dashboard-contact-item"
                            onClick={() => navigate('/crm')}
                          >
                            <div
                              className="contact-avatar-sm"
                              style={{ backgroundColor: getStatusColor(contact.status) }}
                            >
                              {contact.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="dashboard-contact-info">
                              <div className="dashboard-contact-name">{contact.name}</div>
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
                      {contacts.length > 10 && (
                        <div className="show-more" onClick={() => navigate('/crm')}>
                          + {contacts.length - 10} dalsich kontaktov
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Tasks Section */}
                <div className="dashboard-section">
                  <div className="section-header">
                    <h3>Ulohy ({tasks.length})</h3>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => navigate('/tasks')}
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
                      {tasks.filter(t => !t.completed).slice(0, 8).map(task => (
                        <div
                          key={task.id}
                          className="dashboard-task-item"
                          onClick={() => navigate('/tasks')}
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
                              {task.contactId && getContactName(task.contactId) && (
                                <span className="contact-link-badge">
                                  {getContactName(task.contactId)}
                                </span>
                              )}
                              {task.dueDate && (
                                <span className="due-date-badge">
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
                      {tasks.filter(t => !t.completed).length > 8 && (
                        <div className="show-more" onClick={() => navigate('/tasks')}>
                          + {tasks.filter(t => !t.completed).length - 8} dalsich uloh
                        </div>
                      )}

                      {/* Completed tasks summary */}
                      {completedTasks > 0 && (
                        <div className="completed-summary" onClick={() => navigate('/tasks')}>
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
                        <div key={contact.id} className="contact-tasks-card" onClick={() => navigate('/crm')}>
                          <div className="contact-tasks-header">
                            <div
                              className="contact-avatar-sm"
                              style={{ backgroundColor: getStatusColor(contact.status) }}
                            >
                              {contact.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="contact-tasks-name">{contact.name}</div>
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
