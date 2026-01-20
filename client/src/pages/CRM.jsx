import { useState, useEffect } from 'react';
import api from '@/api/api';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import UserMenu from '../components/UserMenu';

function CRM() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [contacts, setContacts] = useState([]);
  const [globalTasks, setGlobalTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
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
  const [editTaskDueDate, setEditTaskDueDate] = useState('');
  const [editTaskDescription, setEditTaskDescription] = useState('');

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [subtaskDueDates, setSubtaskDueDates] = useState({});
  const [subtaskNotes, setSubtaskNotes] = useState({});
  const [showSubtaskNotesInput, setShowSubtaskNotesInput] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [editSubtaskNotes, setEditSubtaskNotes] = useState('');
  const [editSubtaskDueDate, setEditSubtaskDueDate] = useState('');
  const [expandedTasks, setExpandedTasks] = useState({});
  const [expandedSubtasks, setExpandedSubtasks] = useState({});
  const [showNotesFor, setShowNotesFor] = useState(null);

  // File states
  const [uploadingFile, setUploadingFile] = useState(null);
  const fileInputRefs = {};
  const [previewFile, setPreviewFile] = useState(null);
  const [previewContact, setPreviewContact] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTextContent, setPreviewTextContent] = useState(null);
  const [previewError, setPreviewError] = useState(null);

  // Duplicate modal states
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicatingTask, setDuplicatingTask] = useState(null);
  const [duplicateContactIds, setDuplicateContactIds] = useState([]);

  useEffect(() => {
    fetchContacts();
    fetchGlobalTasks();
  }, []);

  // Handle navigation state to expand contact from Dashboard
  useEffect(() => {
    if (location.state?.expandContactId && contacts.length > 0) {
      const contactId = location.state.expandContactId;
      setExpandedContact(contactId);

      // Clear the navigation state
      navigate(location.pathname, { replace: true, state: {} });

      // Scroll to contact after a short delay
      setTimeout(() => {
        const contactElement = document.querySelector(`[data-contact-id="${contactId}"]`);
        if (contactElement) {
          contactElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
  }, [location.state, contacts, navigate, location.pathname]);

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

    const token = localStorage.getItem('token');
    const uploadUrl = `${api.defaults.baseURL}/api/contacts/${contactId}/files`;

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();

      xhr.addEventListener('load', async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // Refresh contacts
          try {
            const contactsRes = await api.get('/api/contacts');
            setContacts(contactsRes.data);
          } catch (e) {
            // Silent fail - contacts will refresh on next action
          }
        } else {
          alert('Chyba pri nahrávaní: ' + (xhr.responseText || xhr.status));
        }
        setUploadingFile(null);
        resolve();
      });

      xhr.addEventListener('error', () => {
        // Check if Safari
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        if (isSafari) {
          alert('Safari má problémy s nahrávaním súborov. Použite prosím Chrome alebo Firefox.');
        } else {
          alert('Chyba siete pri nahrávaní súboru');
        }
        setUploadingFile(null);
        resolve();
      });

      xhr.addEventListener('abort', () => {
        setUploadingFile(null);
        resolve();
      });

      xhr.addEventListener('timeout', () => {
        alert('Časový limit vypršal');
        setUploadingFile(null);
        resolve();
      });

      xhr.open('POST', uploadUrl);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.timeout = 60000; // 60 seconds

      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });
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

  const canPreview = () => {
    // Všetky súbory môžu mať náhľad
    return true;
  };

  const isOfficeDocument = (mimetype) => {
    const officeTypes = [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];
    return officeTypes.includes(mimetype);
  };

  const isTextFile = (mimetype, filename) => {
    if (mimetype?.startsWith('text/')) return true;
    const textExtensions = ['.json', '.xml', '.csv', '.md', '.js', '.ts', '.css', '.html', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.sql', '.sh', '.yml', '.yaml'];
    return textExtensions.some(ext => filename?.toLowerCase().endsWith(ext));
  };

  const openPreview = async (file, contactId) => {
    setPreviewFile(file);
    setPreviewContact(contactId);
    setPreviewLoading(true);
    setPreviewTextContent(null);
    setPreviewUrl(null);
    setPreviewError(null);

    const token = localStorage.getItem('token');
    const requestUrl = `${api.defaults.baseURL}/api/contacts/${contactId}/files/${file.id}/download`;

    try {
      const response = await fetch(requestUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const blob = await response.blob();

      // Skontroluj či response obsahuje dáta
      if (!blob || blob.size === 0) {
        setPreviewError('Prázdna odpoveď zo servera');
        return;
      }

      // Pre textové súbory načítaj obsah ako text
      const textExtensions = ['.json', '.xml', '.csv', '.md', '.js', '.ts', '.css', '.html', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.sql', '.sh', '.yml', '.yaml', '.txt'];
      const isText = file.mimetype?.startsWith('text/') || textExtensions.some(ext => file.originalName?.toLowerCase().endsWith(ext));

      if (isText) {
        const text = await blob.text();
        setPreviewTextContent(text);
      }

      const blobUrl = URL.createObjectURL(blob);
      setPreviewUrl(blobUrl);
    } catch (error) {
      console.error('Error loading preview:', error);
      setPreviewError('Nepodarilo sa načítať súbor: ' + (error.message || 'Neznáma chyba'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewFile(null);
    setPreviewContact(null);
    setPreviewUrl(null);
    setPreviewTextContent(null);
    setPreviewError(null);
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
    try {
      await api.post(`/api/tasks/${duplicatingTask.id}/duplicate`, {
        contactIds: duplicateContactIds,
        source: duplicatingTask.source
      });
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
    setEditTaskDueDate(task.dueDate || '');
    setEditTaskDescription(task.description || '');
  };

  const saveTask = async (contact, task) => {
    if (!editTaskTitle.trim()) return;
    try {
      if (task.source === 'global') {
        // Global task
        await api.put(`/api/tasks/${task.id}`, {
          title: editTaskTitle,
          dueDate: editTaskDueDate || null,
          description: editTaskDescription,
          source: 'global'
        });
        await fetchGlobalTasks();
      } else {
        // Contact embedded task
        await api.put(`/api/contacts/${contact.id}/tasks/${task.id}`, {
          title: editTaskTitle,
          dueDate: editTaskDueDate || null,
          description: editTaskDescription
        });
        await fetchContacts();
      }
      setEditingTask(null);
      setEditTaskTitle('');
      setEditTaskDueDate('');
      setEditTaskDescription('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní úlohy');
    }
  };

  const cancelEditTask = () => {
    setEditingTask(null);
    setEditTaskTitle('');
    setEditTaskDueDate('');
    setEditTaskDescription('');
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
    const subtaskNote = subtaskNotes[inputKey] || '';
    if (!subtaskTitle.trim()) return;

    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.post(`/api/tasks/${task.id}/subtasks`, {
          title: subtaskTitle,
          dueDate: subtaskDueDate,
          notes: subtaskNote,
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
          notes: subtaskNote,
          parentSubtaskId: parentSubtaskId
        });
        await fetchContacts();
      }
      setSubtaskInputs(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskDueDates(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskNotes(prev => ({ ...prev, [inputKey]: '' }));
      setShowSubtaskNotesInput(prev => ({ ...prev, [inputKey]: false }));
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
    setEditSubtaskNotes(subtask.notes || '');
    setEditSubtaskDueDate(subtask.dueDate || '');
  };

  const saveSubtask = async (task, subtask) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      // Default to 'contact' source if not specified
      const source = task.source || 'contact';
      if (source === 'global') {
        await api.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
          title: editSubtaskTitle,
          notes: editSubtaskNotes,
          dueDate: editSubtaskDueDate || null,
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
          title: editSubtaskTitle,
          notes: editSubtaskNotes,
          dueDate: editSubtaskDueDate || null
        });
        await fetchContacts();
      }
      setEditingSubtask(null);
      setEditSubtaskTitle('');
      setEditSubtaskNotes('');
      setEditSubtaskDueDate('');
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladani podulohy');
    }
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setEditSubtaskTitle('');
    setEditSubtaskNotes('');
    setEditSubtaskDueDate('');
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
            <div
              className="subtask-checkbox-styled"
              onClick={() => !subtask.completed && toggleSubtask(task, subtask)}
              style={{
                backgroundColor: subtask.completed ? 'var(--accent-color)' : 'transparent'
              }}
            >
              {subtask.completed && '✓'}
            </div>

            {hasChildren && (
              <button
                className="subtask-expand-btn"
                onClick={() => toggleSubtaskExpanded(subtask.id)}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}

            {editingSubtask?.taskId === task.id && editingSubtask?.subtaskId === subtask.id ? (
              <div className="subtask-edit-form-full">
                <div className="subtask-edit-row">
                  <input
                    type="text"
                    value={editSubtaskTitle}
                    onChange={(e) => setEditSubtaskTitle(e.target.value)}
                    className="form-input form-input-sm"
                    autoFocus
                    placeholder="Názov podúlohy"
                  />
                </div>
                <div className="subtask-edit-row">
                  <input
                    type="date"
                    value={editSubtaskDueDate}
                    onChange={(e) => setEditSubtaskDueDate(e.target.value)}
                    className="form-input form-input-sm task-date-input"
                    title="Termín podúlohy"
                  />
                </div>
                <div className="subtask-edit-row">
                  <textarea
                    value={editSubtaskNotes}
                    onChange={(e) => setEditSubtaskNotes(e.target.value)}
                    className="form-input form-input-sm subtask-notes-input"
                    placeholder="Poznámka..."
                    rows={2}
                  />
                </div>
                <div className="subtask-edit-actions">
                  <button onClick={() => saveSubtask(task, subtask)} className="btn btn-primary btn-sm">Uložiť</button>
                  <button onClick={cancelEditSubtask} className="btn btn-secondary btn-sm">Zrušiť</button>
                </div>
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
                {subtask.notes && (
                  <span className="subtask-notes-indicator" title={subtask.notes}>📝</span>
                )}
                {subtask.dueDate && (
                  <span className={`subtask-due-date ${getDueDateClass(subtask.dueDate, subtask.completed)}`}>
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

          {/* Notes display */}
          {subtask.notes && !(editingSubtask?.subtaskId === subtask.id) && (
            <div className="subtask-notes-display" style={{ marginLeft: depth * 16 + 24 }}>
              {subtask.notes}
            </div>
          )}

          {/* Nested subtasks */}
          {isExpanded && hasChildren && (
            <div className="subtask-children">
              {renderCRMSubtasks(task, subtask.subtasks, depth + 1)}
            </div>
          )}

          {/* Add child subtask form */}
          {isExpanded && subtaskInputs[subtask.id] !== undefined && (
            <div className="add-subtask-wrapper" style={{ marginLeft: (depth + 1) * 16 }}>
              <form
                onSubmit={(e) => addSubtask(e, task, subtask.id)}
                className="add-subtask-form nested"
              >
                <input
                  type="text"
                  value={subtaskInputs[subtask.id] || ''}
                  onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                  placeholder="Nová podúloha..."
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
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm ${showSubtaskNotesInput[subtask.id] ? 'active' : ''}`}
                  onClick={() => setShowSubtaskNotesInput(prev => ({ ...prev, [subtask.id]: !prev[subtask.id] }))}
                  title="Pridať poznámku"
                >
                  📝
                </button>
                <button type="submit" className="btn btn-secondary btn-sm">+</button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setSubtaskInputs(prev => {
                      const newInputs = { ...prev };
                      delete newInputs[subtask.id];
                      return newInputs;
                    });
                    setShowSubtaskNotesInput(prev => ({ ...prev, [subtask.id]: false }));
                  }}
                >
                  ×
                </button>
              </form>
              {showSubtaskNotesInput[subtask.id] && (
                <textarea
                  value={subtaskNotes[subtask.id] || ''}
                  onChange={(e) => setSubtaskNotes(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                  placeholder="Poznámka k podúlohe..."
                  className="form-input form-input-sm subtask-notes-input"
                  rows={2}
                />
              )}
            </div>
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
    // First apply status filter
    if (filter !== 'all' && c.status !== filter) return false;

    // Then apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      const nameMatch = c.name?.toLowerCase().includes(query);
      const emailMatch = c.email?.toLowerCase().includes(query);
      const phoneMatch = c.phone?.toLowerCase().includes(query);
      const companyMatch = c.company?.toLowerCase().includes(query);
      const notesMatch = c.notes?.toLowerCase().includes(query);
      // Search in task titles too
      const taskMatch = c.tasks?.some(t => t.title?.toLowerCase().includes(query));
      return nameMatch || emailMatch || phoneMatch || companyMatch || notesMatch || taskMatch;
    }
    return true;
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
          <h1 className="header-title-link" onClick={() => navigate('/')}>Purple CRM</h1>
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
                <div className="search-box">
                  <input
                    type="text"
                    placeholder="Hľadať kontakt..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="search-input"
                  />
                  {searchQuery && (
                    <button
                      className="search-clear"
                      onClick={() => setSearchQuery('')}
                      title="Vymazať"
                    >
                      ×
                    </button>
                  )}
                </div>
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
                    <div key={contact.id} data-contact-id={contact.id} className={`contact-card ${expandedContact === contact.id ? 'expanded' : ''}`}>
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
                                    <span
                                      className={`file-icon ${canPreview(file.mimetype) ? 'clickable' : ''}`}
                                      onClick={() => canPreview(file.mimetype) && openPreview(file, contact.id)}
                                      title={canPreview(file.mimetype) ? 'Zobraziť náhľad' : ''}
                                    >
                                      {getFileIcon(file.mimetype)}
                                    </span>
                                    <div className="file-info">
                                      <span
                                        className={`file-name ${canPreview(file.mimetype) ? 'clickable' : ''}`}
                                        onClick={() => canPreview(file.mimetype) && openPreview(file, contact.id)}
                                      >
                                        {file.originalName}
                                      </span>
                                      <span className="file-size">{formatFileSize(file.size)}</span>
                                    </div>
                                    <div className="file-actions">
                                      {canPreview(file.mimetype) && (
                                        <button
                                          onClick={() => openPreview(file, contact.id)}
                                          className="btn-icon-sm"
                                          title="Náhľad"
                                        >
                                          👁️
                                        </button>
                                      )}
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
                                <div
                                  className="task-checkbox-styled"
                                  onClick={() => !task.completed && toggleTask(contact, task)}
                                  style={{
                                    borderColor: task.priority ? (task.priority === 'high' ? '#EF4444' : task.priority === 'medium' ? '#F59E0B' : '#10B981') : 'var(--accent-color)',
                                    backgroundColor: task.completed ? (task.priority ? (task.priority === 'high' ? '#EF4444' : task.priority === 'medium' ? '#F59E0B' : '#10B981') : 'var(--accent-color)') : 'transparent'
                                  }}
                                >
                                  {task.completed && '✓'}
                                </div>
                                {editingTask?.contactId === contact.id && editingTask?.taskId === task.id ? (
                                  <div className="subtask-edit-form-full">
                                    <div className="subtask-edit-row">
                                      <input
                                        type="text"
                                        value={editTaskTitle}
                                        onChange={(e) => setEditTaskTitle(e.target.value)}
                                        className="form-input form-input-sm"
                                        autoFocus
                                        placeholder="Názov úlohy"
                                      />
                                    </div>
                                    <div className="subtask-edit-row">
                                      <input
                                        type="date"
                                        value={editTaskDueDate}
                                        onChange={(e) => setEditTaskDueDate(e.target.value)}
                                        className="form-input form-input-sm task-date-input"
                                        title="Termín úlohy"
                                      />
                                    </div>
                                    <div className="subtask-edit-row">
                                      <textarea
                                        value={editTaskDescription}
                                        onChange={(e) => setEditTaskDescription(e.target.value)}
                                        className="form-input form-input-sm subtask-notes-input"
                                        placeholder="Poznámka..."
                                        rows={2}
                                      />
                                    </div>
                                    <div className="subtask-edit-actions">
                                      <button onClick={() => saveTask(contact, task)} className="btn btn-primary btn-sm">Uložiť</button>
                                      <button onClick={cancelEditTask} className="btn btn-secondary btn-sm">Zrušiť</button>
                                    </div>
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
                                        <span className={`task-due-date ${getDueDateClass(task.dueDate, task.completed)}`}>
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
                                      <div className="add-subtask-wrapper">
                                        <form onSubmit={(e) => addSubtask(e, { ...task, contactId: contact.id })} className="add-subtask-inline">
                                          <input
                                            type="text"
                                            value={subtaskInputs[`${contact.id}-${task.id}`] || ''}
                                            onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [`${contact.id}-${task.id}`]: e.target.value }))}
                                            placeholder="Pridať podúlohu..."
                                            className="form-input form-input-sm"
                                          />
                                          <input
                                            type="date"
                                            value={subtaskDueDates[`${contact.id}-${task.id}`] || ''}
                                            onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [`${contact.id}-${task.id}`]: e.target.value }))}
                                            className="form-input form-input-sm task-date-input"
                                            title="Termín podúlohy"
                                          />
                                          <button
                                            type="button"
                                            className={`btn btn-secondary btn-sm ${showSubtaskNotesInput[`${contact.id}-${task.id}`] ? 'active' : ''}`}
                                            onClick={() => setShowSubtaskNotesInput(prev => ({ ...prev, [`${contact.id}-${task.id}`]: !prev[`${contact.id}-${task.id}`] }))}
                                            title="Pridať poznámku"
                                          >
                                            📝
                                          </button>
                                          <button type="submit" className="btn btn-secondary btn-sm">+</button>
                                        </form>
                                        {showSubtaskNotesInput[`${contact.id}-${task.id}`] && (
                                          <textarea
                                            value={subtaskNotes[`${contact.id}-${task.id}`] || ''}
                                            onChange={(e) => setSubtaskNotes(prev => ({ ...prev, [`${contact.id}-${task.id}`]: e.target.value }))}
                                            placeholder="Poznámka k podúlohe..."
                                            className="form-input form-input-sm subtask-notes-input"
                                            rows={2}
                                          />
                                        )}
                                      </div>
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

      {/* File Preview Modal */}
      {previewFile && previewContact && (
        <div className="modal-overlay file-preview-overlay" onClick={closePreview}>
          <div className="file-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="file-preview-header">
              <h3>{previewFile.originalName}</h3>
              <div className="file-preview-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => downloadFile(previewContact, previewFile.id, previewFile.originalName)}
                >
                  ⬇️ Stiahnuť
                </button>
                <button className="btn-icon file-preview-close" onClick={closePreview}>×</button>
              </div>
            </div>
            <div className="file-preview-content">
              {previewLoading ? (
                <div className="preview-loading">
                  <span>Načítavam náhľad...</span>
                </div>
              ) : previewError ? (
                <div className="preview-error">
                  <span className="preview-icon">⚠️</span>
                  <p>{previewError}</p>
                  <button
                    className="btn btn-primary"
                    onClick={() => downloadFile(previewContact, previewFile.id, previewFile.originalName)}
                  >
                    Stiahnuť súbor
                  </button>
                </div>
              ) : previewFile.mimetype?.startsWith('image/') && previewUrl ? (
                <img
                  src={previewUrl}
                  alt={previewFile.originalName}
                  className="preview-image"
                />
              ) : (previewFile.mimetype === 'application/pdf' || previewFile.originalName?.toLowerCase().endsWith('.pdf')) && previewUrl ? (
                <object
                  data={previewUrl}
                  type="application/pdf"
                  className="preview-pdf"
                >
                  <div className="preview-pdf-fallback">
                    <span className="preview-icon">📄</span>
                    <p>PDF náhľad nie je dostupný v tomto prehliadači</p>
                    <button
                      className="btn btn-primary"
                      onClick={() => downloadFile(previewContact, previewFile.id, previewFile.originalName)}
                    >
                      Stiahnuť PDF
                    </button>
                  </div>
                </object>
              ) : previewFile.mimetype?.startsWith('video/') && previewUrl ? (
                <video
                  src={previewUrl}
                  controls
                  className="preview-video"
                >
                  Váš prehliadač nepodporuje prehrávanie videa.
                </video>
              ) : previewFile.mimetype?.startsWith('audio/') && previewUrl ? (
                <div className="preview-audio">
                  <span className="preview-icon">🎵</span>
                  <audio
                    src={previewUrl}
                    controls
                    className="audio-player"
                  >
                    Váš prehliadač nepodporuje prehrávanie audia.
                  </audio>
                </div>
              ) : isTextFile(previewFile.mimetype, previewFile.originalName) && previewTextContent !== null ? (
                <div className="preview-text">
                  <pre>{previewTextContent}</pre>
                </div>
              ) : isOfficeDocument(previewFile.mimetype) && previewUrl ? (
                <div className="preview-office">
                  <span className="preview-icon">{getFileIcon(previewFile.mimetype)}</span>
                  <p>Pre zobrazenie Office dokumentov stiahnite súbor</p>
                  <button
                    className="btn btn-primary"
                    onClick={() => downloadFile(previewContact, previewFile.id, previewFile.originalName)}
                  >
                    Stiahnuť a otvoriť
                  </button>
                </div>
              ) : (
                <div className="preview-generic">
                  <span className="preview-icon">{getFileIcon(previewFile.mimetype)}</span>
                  <p className="file-info-text">
                    <strong>{previewFile.originalName}</strong>
                    <br />
                    Typ: {previewFile.mimetype || 'Neznámy'}
                    <br />
                    Veľkosť: {formatFileSize(previewFile.size)}
                  </p>
                  <button
                    className="btn btn-primary"
                    onClick={() => downloadFile(previewContact, previewFile.id, previewFile.originalName)}
                  >
                    Stiahnuť súbor
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CRM;
