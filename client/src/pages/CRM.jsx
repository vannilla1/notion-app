import { useState, useEffect } from 'react';
import api from '@/api/api';
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
  const [taskDueDates, setTaskDueDates] = useState({});
  const [editingTask, setEditingTask] = useState(null);
  const [editTaskTitle, setEditTaskTitle] = useState('');

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [subtaskDueDates, setSubtaskDueDates] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [expandedTasks, setExpandedTasks] = useState({});
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  // File states
  const [uploadingFile, setUploadingFile] = useState(null);
  const fileInputRefs = {};

  // Duplicate modal states
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicatingTask, setDuplicatingTask] = useState(null);
  const [duplicateContactIds, setDuplicateContactIds] = useState([]);

  useEffect(() => {
    fetchContacts();
    fetchGlobalTasks();
  }, []);

  // Get all tasks for a contact (embedded + global assigned)
  const getContactTasks = (contact) => {
    const embeddedTasks = (contact.tasks || []).map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      completed: t.completed,
      priority: t.priority,
      dueDate: t.dueDate,
      subtasks: t.subtasks || [],
      source: 'contact',
      contactId: contact.id
    }));
    // Support both old contactId and new contactIds
    const assignedGlobalTasks = globalTasks
      .filter(t => {
        const taskContactIds = t.contactIds?.length > 0
          ? t.contactIds
          : (t.contactId ? [t.contactId] : []);
        return taskContactIds.includes(contact.id) && t.source === 'global';
      })
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
      const res = await api.get('/api/contacts');
      setContacts(res.data);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchGlobalTasks = async () => {
    try {
      const res = await api.get('/api/tasks');
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
      await api.post('/api/contacts', newContactForm);
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
      await api.delete(`/api/contacts/${contact.id}`);
    } catch (error) {
      console.error('Failed to delete contact:', error);
    }
  };

  // File functions
  const handleFileUpload = async (contactId, file) => {
    if (!file) return;

    setUploadingFile(contactId);
    const formData = new FormData();
    formData.append('file', file);

    try {
      await api.post(`/api/contacts/${contactId}/files`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri nahrávaní súboru');
    } finally {
      setUploadingFile(null);
    }
  };

  const deleteFile = async (contactId, fileId) => {
    if (!window.confirm('Vymazať tento súbor?')) return;
    try {
      await api.delete(`/api/contacts/${contactId}/files/${fileId}`);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri mazaní súboru');
    }
  };

  const downloadFile = (contactId, fileId, fileName) => {
    const token = localStorage.getItem('token');
    const url = `${api.defaults.baseURL}/api/contacts/${contactId}/files/${fileId}/download`;

    fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(response => response.blob())
      .then(blob => {
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = fileName;
        link.click();
      })
      .catch(err => alert('Chyba pri sťahovaní súboru'));
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getFileIcon = (mimetype) => {
    if (mimetype?.startsWith('image/')) return '🖼️';
    if (mimetype === 'application/pdf') return '📄';
    if (mimetype?.includes('word')) return '📝';
    if (mimetype?.includes('excel') || mimetype?.includes('spreadsheet')) return '📊';
    return '📎';
  };

  // Duplicate task functions
  const openDuplicateModal = (task, currentContactId) => {
    setDuplicatingTask({ ...task, currentContactId });
    setDuplicateContactIds([]);
    setShowDuplicateModal(true);
  };

  const closeDuplicateModal = () => {
    setShowDuplicateModal(false);
    setDuplicatingTask(null);
    setDuplicateContactIds([]);
  };

  const duplicateTask = async () => {
    if (!duplicatingTask) return;
    console.log('Duplicating task:', duplicatingTask);
    console.log('Task ID:', duplicatingTask.id);
    console.log('Contact IDs:', duplicateContactIds);
    try {
      const response = await api.post(`/api/tasks/${duplicatingTask.id}/duplicate`, {
        contactIds: duplicateContactIds,
        source: duplicatingTask.source
      });
      console.log('Duplicate response:', response.data);
      closeDuplicateModal();
      fetchGlobalTasks();
      fetchContacts();
    } catch (error) {
      console.error('Duplicate error:', error);
      console.error('Error response:', error.response?.data);
      alert(error.response?.data?.message || 'Chyba pri duplikovaní úlohy');
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
      await api.put(`/api/contacts/${contactId}`, editForm);
      setEditingContact(null);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní kontaktu');
    }
  };

  // Task functions
  const addTask = async (e, contact) => {
    e.preventDefault();
    const taskTitle = taskInputs[contact.id] || '';
    const taskDueDate = taskDueDates[contact.id] || null;
    if (!taskTitle.trim()) return;

    try {
      await api.post(`/api/contacts/${contact.id}/tasks`, {
        title: taskTitle,
        dueDate: taskDueDate
      });
      setTaskInputs(prev => ({ ...prev, [contact.id]: '' }));
      setTaskDueDates(prev => ({ ...prev, [contact.id]: '' }));
      await fetchContacts();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní úlohy');
    }
  };

  const toggleTask = async (contact, task) => {
    if (!task.completed) {
      if (!window.confirm(`Naozaj chcete označiť úlohu "${task.title}" ako dokončenú?`)) return;
    }
    try {
      if (task.source === 'global') {
        // Global task - use /api/tasks endpoint
        await api.put(`/api/tasks/${task.id}`, {
          completed: !task.completed,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await api.put(`/api/contacts/${contact.id}/tasks/${task.id}`, {
          completed: !task.completed
        });
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (contact, task) => {
    if (!window.confirm(`Naozaj chcete vymazať úlohu "${task.title}"?`)) return;
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        // Global task - use /api/tasks endpoint
        await api.delete(`/api/tasks/${task.id}?source=global`);
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        if (!contact.id || !task.id) {
          console.error('Missing required IDs for delete task:', { contactId: contact.id, taskId: task.id });
          alert('Chyba: Chýbajúce údaje pre vymazanie úlohy');
          return;
        }
        await api.delete(`/api/contacts/${contact.id}/tasks/${task.id}`);
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to delete task:', error);
      alert('Chyba pri mazaní úlohy');
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
        await api.put(`/api/tasks/${task.id}`, {
          title: editTaskTitle,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await api.put(`/api/contacts/${contact.id}/tasks/${task.id}`, {
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
    // Use unique key: contactId-taskId for embedded tasks, or parentSubtaskId for nested subtasks
    const inputKey = parentSubtaskId || (task.contactId ? `${task.contactId}-${task.id}` : task.id);
    const subtaskTitle = subtaskInputs[inputKey] || '';
    const subtaskDueDate = subtaskDueDates[inputKey] || null;
    if (!subtaskTitle.trim()) return;

    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.post(`/api/tasks/${task.id}/subtasks`, {
          title: subtaskTitle,
          dueDate: subtaskDueDate,
          source: 'global',
          parentSubtaskId: parentSubtaskId
        });
        await fetchGlobalTasks();
      } else {
        if (!task.contactId || !task.id) {
          console.error('Missing required IDs for add subtask:', { contactId: task.contactId, taskId: task.id });
          alert('Chyba: Chýbajúce údaje');
          return;
        }
        await api.post(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks`, {
          title: subtaskTitle,
          dueDate: subtaskDueDate,
          parentSubtaskId: parentSubtaskId
        });
        await fetchContacts();
      }
      setSubtaskInputs(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskDueDates(prev => ({ ...prev, [inputKey]: '' }));
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytvarani podulohy');
    }
  };

  const toggleSubtask = async (task, subtask) => {
    if (!subtask.completed) {
      if (!window.confirm(`Naozaj chcete označiť podúlohu "${subtask.title}" ako dokončenú?`)) return;
    }
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          completed: !subtask.completed,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        if (!task.contactId || !task.id || !subtask.id) {
          console.error('Missing required IDs for toggle:', { contactId: task.contactId, taskId: task.id, subtaskId: subtask.id });
          alert('Chyba: Chýbajúce údaje');
          return;
        }
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`, {
          completed: !subtask.completed
        });
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to toggle subtask:', error);
      alert('Chyba pri aktualizácii podúlohy');
    }
  };

  const deleteSubtask = async (task, subtask) => {
    if (!window.confirm(`Naozaj chcete vymazať podúlohu "${subtask.title}"?`)) return;
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.delete(`/api/tasks/${task.id}/subtasks/${subtask.id}?source=global`);
        await fetchGlobalTasks();
      } else {
        if (!task.contactId || !task.id || !subtask.id) {
          console.error('Missing required IDs:', { contactId: task.contactId, taskId: task.id, subtaskId: subtask.id });
          alert('Chyba: Chýbajúce údaje pre vymazanie podúlohy');
          return;
        }
        await api.delete(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`);
        await fetchContacts();
      }
    } catch (error) {
      console.error('Failed to delete subtask:', error);
      alert('Chyba pri mazaní podúlohy');
    }
  };

  const startEditSubtask = (task, subtask) => {
    setEditingSubtask({ taskId: task.id, subtaskId: subtask.id, source: task.source });
    setEditSubtaskTitle(subtask.title);
  };

  const saveSubtask = async (task, subtask) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          title: editSubtaskTitle,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        if (!task.contactId || !task.id || !subtask.id) {
          console.error('Missing required IDs for save:', { contactId: task.contactId, taskId: task.id, subtaskId: subtask.id });
          alert('Chyba: Chýbajúce údaje');
          return;
        }
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`, {
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

  const updateSubtaskDueDate = async (task, subtask, dueDate) => {
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          dueDate: dueDate || null,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        if (!task.contactId || !task.id || !subtask.id) {
          console.error('Missing required IDs for due date:', { contactId: task.contactId, taskId: task.id, subtaskId: subtask.id });
          alert('Chyba: Chýbajúce údaje');
          return;
        }
        await api.put(`/api/contacts/${task.contactId}/tasks/${task.id}/subtasks/${subtask.id}`, {
          dueDate: dueDate || null
        });
        await fetchContacts();
      }
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri nastavovaní termínu');
    }
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
              onChange={() => !subtask.completed && toggleSubtask(task, subtask)}
              disabled={subtask.completed}
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
                {subtask.dueDate && (
                  <span className={`subtask-due-date ${new Date(subtask.dueDate) < new Date() && !subtask.completed ? 'overdue' : ''}`}>
                    📅 {new Date(subtask.dueDate).toLocaleDateString('sk-SK')}
                  </span>
                )}
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
              <input
                type="date"
                value={subtaskDueDates[subtask.id] || ''}
                onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                className="form-input form-input-sm task-date-input"
                title="Termín podúlohy"
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

          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              <span className="stat-label">Celkom kontaktov</span>
              <span className="stat-value">{contacts.length}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa stavu</h4>
            <div
              className={`stat-item clickable priority-stat ${filter === 'new' ? 'active' : ''}`}
              onClick={() => setFilter('new')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#3B82F6' }}></span>
                Nový
              </span>
              <span className="stat-value">{statusCounts.new}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${filter === 'active' ? 'active' : ''}`}
              onClick={() => setFilter('active')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Aktívny
              </span>
              <span className="stat-value">{statusCounts.active}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${filter === 'completed' ? 'active' : ''}`}
              onClick={() => setFilter('completed')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#6366F1' }}></span>
                Dokončený
              </span>
              <span className="stat-value">{statusCounts.completed}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${filter === 'cancelled' ? 'active' : ''}`}
              onClick={() => setFilter('cancelled')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Zrušený
              </span>
              <span className="stat-value">{statusCounts.cancelled}</span>
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
                      type="text"
                      value={newContactForm.website}
                      onChange={(e) => setNewContactForm({ ...newContactForm, website: e.target.value })}
                      placeholder="www.example.sk"
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
                              type="text"
                              value={editForm.website}
                              onChange={(e) => setEditForm({ ...editForm, website: e.target.value })}
                              className="form-input"
                              placeholder="www.example.sk"
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
                                <a href={contact.website.startsWith('http') ? contact.website : `https://${contact.website}`} target="_blank" rel="noopener noreferrer" className="detail-value website-link">
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

                          {/* Files Section */}
                          <div className="contact-files">
                            <div className="files-section-header">
                              <span>Súbory</span>
                              <label className="btn btn-secondary btn-sm file-upload-btn">
                                {uploadingFile === contact.id ? 'Nahrávam...' : '+ Pridať súbor'}
                                <input
                                  type="file"
                                  hidden
                                  onChange={(e) => {
                                    handleFileUpload(contact.id, e.target.files[0]);
                                    e.target.value = '';
                                  }}
                                  disabled={uploadingFile === contact.id}
                                />
                              </label>
                            </div>

                            {contact.files && contact.files.length > 0 ? (
                              <div className="files-list">
                                {contact.files.map(file => (
                                  <div key={file.id} className="file-item">
                                    <span className="file-icon">{getFileIcon(file.mimetype)}</span>
                                    <div className="file-info">
                                      <span className="file-name">{file.originalName}</span>
                                      <span className="file-size">{formatFileSize(file.size)}</span>
                                    </div>
                                    <div className="file-actions">
                                      <button
                                        onClick={() => downloadFile(contact.id, file.id, file.originalName)}
                                        className="btn-icon-sm"
                                        title="Stiahnuť"
                                      >
                                        ⬇️
                                      </button>
                                      <button
                                        onClick={() => deleteFile(contact.id, file.id)}
                                        className="btn-icon-sm btn-danger"
                                        title="Vymazať"
                                      >
                                        🗑️
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="no-files">Žiadne súbory</div>
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
                                  onChange={() => !task.completed && toggleTask(contact, task)}
                                  disabled={task.completed}
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
                                      {task.dueDate && (
                                        <span className={`task-due-date ${new Date(task.dueDate) < new Date() && !task.completed ? 'overdue' : ''}`}>
                                          📅 {new Date(task.dueDate).toLocaleDateString('sk-SK')}
                                        </span>
                                      )}
                                      {task.subtasks?.length > 0 && (
                                        <span className="subtask-count">
                                          ({countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total})
                                        </span>
                                      )}
                                    </span>
                                    <div className="task-item-actions">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); toggleTaskExpanded(`${contact.id}-${task.id}`); }}
                                        className="btn-icon-sm"
                                        title={expandedTasks[`${contact.id}-${task.id}`] ? 'Skryť podúlohy' : 'Zobraziť podúlohy'}
                                      >
                                        {expandedTasks[`${contact.id}-${task.id}`] ? '▼' : '▶'}
                                      </button>
                                      <button
                                        onClick={() => openDuplicateModal(task, contact.id)}
                                        className="btn-icon-sm"
                                        title="Duplikovať"
                                      >
                                        📋
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
                                {expandedTasks[`${contact.id}-${task.id}`] && (
                                  <div className="subtasks-container">
                                    <div className="subtask-tree">
                                      {renderCRMSubtasks({ ...task, contactId: contact.id }, task.subtasks, 0)}
                                    </div>

                                    {!task.completed && (
                                      <form onSubmit={(e) => addSubtask(e, { ...task, contactId: contact.id })} className="add-subtask-inline">
                                        <input
                                          type="text"
                                          value={subtaskInputs[`${contact.id}-${task.id}`] || ''}
                                          onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [`${contact.id}-${task.id}`]: e.target.value }))}
                                          placeholder="Pridat podulohu..."
                                          className="form-input form-input-sm"
                                        />
                                        <input
                                          type="date"
                                          value={subtaskDueDates[`${contact.id}-${task.id}`] || ''}
                                          onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [`${contact.id}-${task.id}`]: e.target.value }))}
                                          className="form-input form-input-sm task-date-input"
                                          title="Termín podúlohy"
                                        />
                                        <button type="submit" className="btn btn-secondary btn-sm">+</button>
                                      </form>
                                    )}
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
                              <input
                                type="date"
                                value={taskDueDates[contact.id] || ''}
                                onChange={(e) => setTaskDueDates(prev => ({ ...prev, [contact.id]: e.target.value }))}
                                className="form-input form-input-sm task-date-input"
                                title="Termín úlohy"
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

      {/* Duplicate Modal */}
      {showDuplicateModal && duplicatingTask && (
        <div className="modal-overlay" onClick={closeDuplicateModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Duplikovať úlohu</h3>
              <button className="modal-close" onClick={closeDuplicateModal}>×</button>
            </div>
            <div className="modal-body">
              <p className="duplicate-info">
                Duplikuje sa úloha: <strong>{duplicatingTask.title}</strong>
                {duplicatingTask.subtasks?.length > 0 && (
                  <span className="subtask-info"> (vrátane {duplicatingTask.subtasks.length} podúloh)</span>
                )}
              </p>

              <div className="form-group">
                <label>Priradiť ku kontaktom</label>
                <div className="multi-select-contacts">
                  {contacts.map(contact => (
                    <label key={contact.id} className="contact-checkbox">
                      <input
                        type="checkbox"
                        checked={duplicateContactIds.includes(contact.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDuplicateContactIds(prev =>
                            checked
                              ? [...prev, contact.id]
                              : prev.filter(id => id !== contact.id)
                          );
                        }}
                      />
                      <span>{contact.name} {contact.company ? `(${contact.company})` : ''}</span>
                    </label>
                  ))}
                  {contacts.length === 0 && (
                    <span className="no-contacts">Žiadne kontakty</span>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeDuplicateModal}>Zrušiť</button>
              <button className="btn btn-primary" onClick={duplicateTask}>Duplikovať</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CRM;
