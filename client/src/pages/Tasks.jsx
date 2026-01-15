import { useState, useEffect, useRef } from 'react';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from '../components/UserMenu';

function Tasks() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [expandedTask, setExpandedTask] = useState(null);
  const { socket, isConnected } = useSocket();
  const [highlightedTaskId, setHighlightedTaskId] = useState(null);
  const taskRefs = useRef({});

  // Form states
  const [newTaskForm, setNewTaskForm] = useState({
    title: '',
    description: '',
    dueDate: '',
    priority: 'medium',
    contactIds: [],
    assignedTo: []
  });

  // Edit states
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [subtaskDueDates, setSubtaskDueDates] = useState({});
  const [subtaskNotes, setSubtaskNotes] = useState({});
  const [subtaskAssignedTo, setSubtaskAssignedTo] = useState({});
  const [showSubtaskNotesInput, setShowSubtaskNotesInput] = useState({});
  const [showSubtaskAssignInput, setShowSubtaskAssignInput] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [editSubtaskNotes, setEditSubtaskNotes] = useState('');
  const [editSubtaskDueDate, setEditSubtaskDueDate] = useState('');
  const [editSubtaskAssignedTo, setEditSubtaskAssignedTo] = useState([]);
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  // Duplicate modal states
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicatingTask, setDuplicatingTask] = useState(null);
  const [duplicateContactIds, setDuplicateContactIds] = useState([]);

  // Calendar export dropdown
  const [showCalendarMenu, setShowCalendarMenu] = useState(false);
  const calendarMenuRef = useRef(null);

  useEffect(() => {
    fetchTasks();
    fetchContacts();
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const res = await api.get('/api/auth/users');
      setUsers(res.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    }
  };

  // Close calendar menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (calendarMenuRef.current && !calendarMenuRef.current.contains(event.target)) {
        setShowCalendarMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  // Check if current filter is a due date filter
  const isDueDateFilter = (f) => ['due-success', 'due-warning', 'due-danger', 'overdue'].includes(f);

  // Check if task or any subtask has specific due date class (recursive)
  const hasSubtaskWithDueClass = (subtasks, dueClass) => {
    if (!subtasks || subtasks.length === 0) return false;
    for (const subtask of subtasks) {
      if (!subtask.completed && getDueDateClass(subtask.dueDate, subtask.completed) === dueClass) return true;
      if (subtask.subtasks && hasSubtaskWithDueClass(subtask.subtasks, dueClass)) return true;
    }
    return false;
  };

  // Get IDs of subtasks matching due date class (recursive)
  const getMatchingSubtaskIds = (subtasks, dueClass) => {
    const ids = new Set();
    if (!subtasks || subtasks.length === 0) return ids;
    for (const subtask of subtasks) {
      if (!subtask.completed && getDueDateClass(subtask.dueDate, subtask.completed) === dueClass) {
        ids.add(subtask.id);
      }
      if (subtask.subtasks) {
        const childIds = getMatchingSubtaskIds(subtask.subtasks, dueClass);
        childIds.forEach(id => ids.add(id));
      }
    }
    return ids;
  };

  // Get IDs of parent subtasks that need to be expanded to show matching children
  const getParentSubtaskIds = (subtasks, dueClass, parentIds = new Set()) => {
    if (!subtasks || subtasks.length === 0) return parentIds;
    for (const subtask of subtasks) {
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        const hasMatchingChild = hasSubtaskWithDueClass(subtask.subtasks, dueClass);
        const selfMatches = !subtask.completed && getDueDateClass(subtask.dueDate, subtask.completed) === dueClass;
        if (hasMatchingChild || selfMatches) {
          parentIds.add(subtask.id);
        }
        getParentSubtaskIds(subtask.subtasks, dueClass, parentIds);
      }
    }
    return parentIds;
  };

  // Check if a date is within the last 24 hours
  const isWithin24Hours = (dateString) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return false; // Invalid date
    const now = new Date();
    const diff = now - date;
    const hours24 = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    return diff >= 0 && diff <= hours24;
  };

  // Check if task is new or modified (uses modifiedAt field only)
  // modifiedAt is set when task is created or modified by user
  const isNewOrModified = (task) => {
    // Only check modifiedAt - this field is set on creation and updates
    if (task.modifiedAt && isWithin24Hours(task.modifiedAt)) return true;
    return false;
  };

  // Check if subtask is new or modified
  const isSubtaskNewOrModified = (subtask) => {
    // Only check modifiedAt - this field is set on creation and updates
    if (subtask.modifiedAt && isWithin24Hours(subtask.modifiedAt)) return true;
    return false;
  };

  // Check if any subtask is new or modified (recursive)
  const hasNewOrModifiedSubtask = (subtasks) => {
    if (!subtasks || subtasks.length === 0) return false;
    for (const subtask of subtasks) {
      if (isSubtaskNewOrModified(subtask)) return true;
      if (subtask.subtasks && hasNewOrModifiedSubtask(subtask.subtasks)) return true;
    }
    return false;
  };

  // Count tasks and subtasks that are new or modified
  const countNewOrModified = (tasks) => {
    let count = 0;
    for (const task of tasks) {
      if (isNewOrModified(task)) count++;
      else if (hasNewOrModifiedSubtask(task.subtasks)) count++;
    }
    return count;
  };

  // Get IDs of subtasks that are new or modified (recursive)
  const getNewOrModifiedSubtaskIds = (subtasks) => {
    const ids = new Set();
    if (!subtasks || subtasks.length === 0) return ids;
    for (const subtask of subtasks) {
      if (isSubtaskNewOrModified(subtask)) {
        ids.add(subtask.id);
      }
      if (subtask.subtasks) {
        const childIds = getNewOrModifiedSubtaskIds(subtask.subtasks);
        childIds.forEach(id => ids.add(id));
      }
    }
    return ids;
  };

  // Get IDs of parent subtasks that need to be expanded to show new/modified children
  const getParentSubtaskIdsForNew = (subtasks, parentIds = new Set()) => {
    if (!subtasks || subtasks.length === 0) return parentIds;
    for (const subtask of subtasks) {
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        const hasNewChild = hasNewOrModifiedSubtask(subtask.subtasks);
        const selfIsNew = isSubtaskNewOrModified(subtask);
        if (hasNewChild || selfIsNew) {
          parentIds.add(subtask.id);
        }
        getParentSubtaskIdsForNew(subtask.subtasks, parentIds);
      }
    }
    return parentIds;
  };

  // Handle highlight from navigation state
  useEffect(() => {
    if (location.state?.highlightTaskId && tasks.length > 0) {
      const taskId = location.state.highlightTaskId;
      setHighlightedTaskId(taskId);
      setExpandedTask(taskId);

      // Scroll to the task after a short delay
      setTimeout(() => {
        if (taskRefs.current[taskId]) {
          taskRefs.current[taskId].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);

      // Remove highlight after 3 seconds
      setTimeout(() => {
        setHighlightedTaskId(null);
      }, 3000);

      // Clear the navigation state
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, tasks, navigate, location.pathname]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleTaskCreated = (task) => {
      setTasks(prev => {
        // Avoid duplicates - check if task already exists
        if (prev.some(t => t.id === task.id)) return prev;
        return [...prev, task];
      });
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

    // When a contact is updated, refresh tasks to get updated embedded tasks
    const handleContactUpdated = () => {
      fetchTasks();
    };

    socket.on('task-created', handleTaskCreated);
    socket.on('task-updated', handleTaskUpdated);
    socket.on('task-deleted', handleTaskDeleted);
    socket.on('contact-updated', handleContactUpdated);

    return () => {
      socket.off('task-created', handleTaskCreated);
      socket.off('task-updated', handleTaskUpdated);
      socket.off('task-deleted', handleTaskDeleted);
      socket.off('contact-updated', handleContactUpdated);
    };
  }, [socket, isConnected]);

  // Auto-expand tasks and subtasks when due date filter or 'new' filter is active
  useEffect(() => {
    if ((!isDueDateFilter(filter) && filter !== 'new') || tasks.length === 0) return;

    const tasksToExpand = new Set();
    const subtasksToExpand = {};

    if (filter === 'new') {
      // Handle 'new' filter
      for (const task of tasks) {
        const taskIsNew = isNewOrModified(task);
        const hasNewSubtasks = hasNewOrModifiedSubtask(task.subtasks);

        if (taskIsNew || hasNewSubtasks) {
          tasksToExpand.add(task.id);

          if (hasNewSubtasks) {
            const parentIds = getParentSubtaskIdsForNew(task.subtasks);
            parentIds.forEach(id => {
              subtasksToExpand[id] = true;
            });
          }
        }
      }
    } else {
      // Handle due date filters
      const dueClass = filter;
      for (const task of tasks) {
        const taskMatches = !task.completed && getDueDateClass(task.dueDate, task.completed) === dueClass;
        const hasMatchingSubtasks = hasSubtaskWithDueClass(task.subtasks, dueClass);

        if (taskMatches || hasMatchingSubtasks) {
          tasksToExpand.add(task.id);

          if (hasMatchingSubtasks) {
            const parentIds = getParentSubtaskIds(task.subtasks, dueClass);
            parentIds.forEach(id => {
              subtasksToExpand[id] = true;
            });
          }
        }
      }
    }

    // Expand first matching task
    if (tasksToExpand.size > 0) {
      const firstTaskId = Array.from(tasksToExpand)[0];
      setExpandedTask(firstTaskId);
    }

    // Expand subtasks that have matching children
    if (Object.keys(subtasksToExpand).length > 0) {
      setExpandedSubtasks(prev => ({ ...prev, ...subtasksToExpand }));
    }
  }, [filter, tasks]);

  const fetchTasks = async () => {
    try {
      const res = await api.get('/api/tasks');
      setTasks(res.data);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchContacts = async () => {
    try {
      const res = await api.get('/api/contacts');
      setContacts(res.data);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    }
  };

  const refreshTask = async (taskId) => {
    try {
      const res = await api.get(`/api/tasks/${taskId}`);
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
      const response = await api.post('/api/tasks', {
        ...newTaskForm,
        contactIds: newTaskForm.contactIds.length > 0 ? newTaskForm.contactIds : []
      });

      // Handle response - could be single task or multiple tasks
      const responseData = response.data;

      if (responseData.tasks && Array.isArray(responseData.tasks)) {
        // Multiple tasks created (one per contact)
        setTasks(prev => {
          const newTasks = responseData.tasks.filter(t => !prev.some(existing => existing.id === t.id));
          return [...newTasks, ...prev];
        });
      } else if (responseData && responseData.id) {
        // Single task created
        setTasks(prev => {
          if (prev.some(t => t.id === responseData.id)) return prev;
          return [responseData, ...prev];
        });
      }

      // Refresh to get updated list from server
      await fetchTasks();

      setNewTaskForm({
        title: '',
        description: '',
        dueDate: '',
        priority: 'medium',
        contactIds: [],
        assignedTo: []
      });
      setShowForm(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní úlohy');
    }
  };

  const toggleTask = async (task) => {
    if (!task.completed) {
      if (!window.confirm(`Naozaj chcete označiť úlohu "${task.title}" ako dokončenú?`)) return;
    }
    try {
      await api.put(`/api/tasks/${task.id}`, {
        completed: !task.completed,
        source: task.source
      });
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (task) => {
    if (!window.confirm(`Naozaj chcete vymazať úlohu "${task.title}"?`)) return;
    try {
      await api.delete(`/api/tasks/${task.id}?source=${task.source || 'global'}`);
      await fetchTasks();
    } catch (error) {
      console.error('Failed to delete task:', error);
      alert('Chyba pri mazaní úlohy');
    }
  };

  // Duplicate task functions
  const openDuplicateModal = (task) => {
    setDuplicatingTask(task);
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
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri duplikovaní úlohy');
    }
  };

  const startEditTask = (task) => {
    setEditingTask(task.id);
    // Support both old contactId and new contactIds
    const taskContactIds = task.contactIds?.length > 0
      ? task.contactIds
      : (task.contactId ? [task.contactId] : []);
    setEditForm({
      title: task.title,
      description: task.description || '',
      dueDate: task.dueDate || '',
      priority: task.priority || 'medium',
      contactIds: taskContactIds,
      assignedTo: task.assignedTo || [],
      source: task.source
    });
  };

  const saveTask = async (taskId) => {
    try {
      const task = tasks.find(t => t.id === taskId);
      await api.put(`/api/tasks/${taskId}`, {
        ...editForm,
        contactIds: editForm.contactIds || [],
        assignedTo: editForm.assignedTo || [],
        source: task?.source || 'global'
      });

      // Refresh tasks to get updated data
      await fetchTasks();
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
    const subtaskDueDate = subtaskDueDates[inputKey] || null;
    const subtaskNote = subtaskNotes[inputKey] || '';
    const subtaskAssigned = subtaskAssignedTo[inputKey] || [];
    if (!subtaskTitle.trim()) return;

    try {
      await api.post(`/api/tasks/${task.id}/subtasks`, {
        title: subtaskTitle,
        dueDate: subtaskDueDate,
        notes: subtaskNote,
        assignedTo: subtaskAssigned,
        source: task.source,
        parentSubtaskId: parentSubtaskId
      });
      setSubtaskInputs(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskDueDates(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskNotes(prev => ({ ...prev, [inputKey]: '' }));
      setSubtaskAssignedTo(prev => ({ ...prev, [inputKey]: [] }));
      setShowSubtaskNotesInput(prev => ({ ...prev, [inputKey]: false }));
      setShowSubtaskAssignInput(prev => ({ ...prev, [inputKey]: false }));
      await fetchTasks();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytvarani podulohy');
    }
  };

  const toggleSubtask = async (task, subtask) => {
    if (!subtask.completed) {
      if (!window.confirm(`Naozaj chcete označiť podúlohu "${subtask.title}" ako dokončenú?`)) return;
    }
    try {
      await api.put(`/api/tasks/${task.id}/subtasks/${subtask.id}`, {
        completed: !subtask.completed,
        source: task.source
      });
      await fetchTasks();
    } catch (error) {
      console.error('Failed to toggle subtask:', error);
    }
  };

  const deleteSubtask = async (task, subtask) => {
    if (!window.confirm(`Naozaj chcete vymazať podúlohu "${subtask.title}"?`)) return;
    try {
      await api.delete(`/api/tasks/${task.id}/subtasks/${subtask.id}?source=${task.source || 'global'}`);
      await fetchTasks();
    } catch (error) {
      console.error('Failed to delete subtask:', error);
    }
  };

  const startEditSubtask = (task, subtask) => {
    setEditingSubtask({ taskId: task.id, subtaskId: subtask.id, source: task.source });
    setEditSubtaskTitle(subtask.title);
    setEditSubtaskNotes(subtask.notes || '');
    setEditSubtaskDueDate(subtask.dueDate || '');
    setEditSubtaskAssignedTo(subtask.assignedTo || []);
  };

  const saveSubtask = async (task, subtaskId) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      await api.put(`/api/tasks/${task.id}/subtasks/${subtaskId}`, {
        title: editSubtaskTitle,
        notes: editSubtaskNotes,
        dueDate: editSubtaskDueDate || null,
        assignedTo: editSubtaskAssignedTo,
        source: task.source
      });
      setEditingSubtask(null);
      setEditSubtaskTitle('');
      setEditSubtaskNotes('');
      setEditSubtaskDueDate('');
      setEditSubtaskAssignedTo([]);
      await fetchTasks();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladani podulohy');
    }
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setEditSubtaskTitle('');
    setEditSubtaskNotes('');
    setEditSubtaskDueDate('');
    setEditSubtaskAssignedTo([]);
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

  // Check if task or any subtask has specific priority (recursive)
  const hasSubtaskWithPriority = (subtasks, priority) => {
    if (!subtasks || subtasks.length === 0) return false;
    for (const subtask of subtasks) {
      if (subtask.priority === priority && !subtask.completed) return true;
      if (subtask.subtasks && hasSubtaskWithPriority(subtask.subtasks, priority)) return true;
    }
    return false;
  };

  // Count tasks and subtasks with specific priority (recursive)
  const countWithPriority = (tasks, priority) => {
    let count = 0;
    for (const task of tasks) {
      if (task.priority === priority && !task.completed) count++;
      if (task.subtasks) {
        count += countSubtasksWithPriority(task.subtasks, priority);
      }
    }
    return count;
  };

  const countSubtasksWithPriority = (subtasks, priority) => {
    if (!subtasks || subtasks.length === 0) return 0;
    let count = 0;
    for (const subtask of subtasks) {
      if (subtask.priority === priority && !subtask.completed) count++;
      if (subtask.subtasks) {
        count += countSubtasksWithPriority(subtask.subtasks, priority);
      }
    }
    return count;
  };

  // Count tasks and subtasks with specific due date class (recursive)
  const countWithDueClass = (tasks, dueClass) => {
    let count = 0;
    for (const task of tasks) {
      if (!task.completed && getDueDateClass(task.dueDate, task.completed) === dueClass) count++;
      if (task.subtasks) {
        count += countSubtasksWithDueClass(task.subtasks, dueClass);
      }
    }
    return count;
  };

  const countSubtasksWithDueClass = (subtasks, dueClass) => {
    if (!subtasks || subtasks.length === 0) return 0;
    let count = 0;
    for (const subtask of subtasks) {
      if (!subtask.completed && getDueDateClass(subtask.dueDate, subtask.completed) === dueClass) count++;
      if (subtask.subtasks) {
        count += countSubtasksWithDueClass(subtask.subtasks, dueClass);
      }
    }
    return count;
  };

  // Recursive subtask renderer
  const renderSubtasks = (task, subtasks, depth = 0) => {
    if (!subtasks || subtasks.length === 0) return null;

    const currentDueClass = isDueDateFilter(filter) ? filter : null;
    const isNewFilter = filter === 'new';

    return subtasks.map(subtask => {
      const hasChildren = subtask.subtasks && subtask.subtasks.length > 0;
      const isExpanded = expandedSubtasks[subtask.id];
      const childCounts = hasChildren ? countSubtasksRecursive(subtask.subtasks) : { total: 0, completed: 0 };

      // Check if this subtask matches the current filter (due date or new)
      const matchesDueFilter = currentDueClass && !subtask.completed &&
        getDueDateClass(subtask.dueDate, subtask.completed) === currentDueClass;
      const matchesNewFilter = isNewFilter && isSubtaskNewOrModified(subtask);
      const matchesFilter = matchesDueFilter || matchesNewFilter;

      return (
        <div key={subtask.id} className="subtask-tree-item" style={{ marginLeft: depth * 16 }}>
          <div className={`subtask-item ${subtask.completed ? 'completed' : ''} ${matchesFilter ? 'filter-match' : ''}`}>
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
                <div className="subtask-edit-row">
                  <label className="subtask-assign-label">Priradení:</label>
                  <div className="subtask-assign-users">
                    {users.map(u => (
                      <label key={u.id} className="subtask-user-checkbox">
                        <input
                          type="checkbox"
                          checked={editSubtaskAssignedTo.includes(u.id)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setEditSubtaskAssignedTo(prev =>
                              checked
                                ? [...prev, u.id]
                                : prev.filter(id => id !== u.id)
                            );
                          }}
                        />
                        <span className="subtask-user-dot" style={{ backgroundColor: u.color }}></span>
                        <span>{u.username}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="subtask-edit-actions">
                  <button onClick={() => saveSubtask(task, subtask.id)} className="btn btn-primary btn-sm">Uložiť</button>
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
                {subtask.assignedTo?.length > 0 && (
                  <span className="subtask-assigned-users">
                    {subtask.assignedTo.map(userId => {
                      const u = users.find(user => user.id === userId);
                      if (!u) return null;
                      return (
                        <span
                          key={u.id}
                          className="subtask-assigned-avatar"
                          style={{ backgroundColor: u.color }}
                          title={u.username}
                        >
                          {u.username.charAt(0).toUpperCase()}
                        </span>
                      );
                    })}
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
              {renderSubtasks(task, subtask.subtasks, depth + 1)}
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
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm ${showSubtaskAssignInput[subtask.id] ? 'active' : ''}`}
                  onClick={() => setShowSubtaskAssignInput(prev => ({ ...prev, [subtask.id]: !prev[subtask.id] }))}
                  title="Priradiť používateľom"
                >
                  👤
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
                    setSubtaskDueDates(prev => {
                      const newDates = { ...prev };
                      delete newDates[subtask.id];
                      return newDates;
                    });
                    setShowSubtaskNotesInput(prev => ({ ...prev, [subtask.id]: false }));
                    setShowSubtaskAssignInput(prev => ({ ...prev, [subtask.id]: false }));
                    setSubtaskAssignedTo(prev => ({ ...prev, [subtask.id]: [] }));
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
              {showSubtaskAssignInput[subtask.id] && (
                <div className="subtask-assign-users-form">
                  {users.map(u => (
                    <label key={u.id} className="subtask-user-checkbox">
                      <input
                        type="checkbox"
                        checked={(subtaskAssignedTo[subtask.id] || []).includes(u.id)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSubtaskAssignedTo(prev => ({
                            ...prev,
                            [subtask.id]: checked
                              ? [...(prev[subtask.id] || []), u.id]
                              : (prev[subtask.id] || []).filter(id => id !== u.id)
                          }));
                        }}
                      />
                      <span className="subtask-user-dot" style={{ backgroundColor: u.color }}></span>
                      <span>{u.username}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
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

  // Download ICS file (works with all calendar apps)
  // options: { incremental: boolean, reset: boolean }
  const downloadIcsFile = async (options = {}) => {
    try {
      const params = new URLSearchParams();
      if (options.incremental) params.append('incremental', 'true');
      if (options.reset) params.append('reset', 'true');

      const url = `/api/tasks/export/calendar${params.toString() ? '?' + params.toString() : ''}`;
      const response = await api.get(url, {
        responseType: 'blob'
      });
      const blob = new Blob([response.data], { type: 'text/calendar;charset=utf-8' });
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = options.incremental ? 'perun-crm-tasks-new.ics' : 'perun-crm-tasks.ics';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
      setShowCalendarMenu(false);

      if (options.incremental) {
        alert('Stiahnuté iba nové úlohy, ktoré ešte neboli exportované.');
      }
    } catch (error) {
      alert('Chyba pri exporte kalendára');
    }
  };

  // Open Google Calendar import page
  const openInGoogleCalendar = () => {
    // Open Google Calendar import page directly
    // User will need to download .ics file separately and import it there
    window.open('https://calendar.google.com/calendar/r/settings/export', '_blank');

    // Show instructions
    alert('Google Calendar sa otvoril v novom tabe.\n\nPre import úloh:\n1. Kliknite na "Stiahnuť .ics súbor" v menu\n2. V Google Calendar kliknite na "Vybrať súbor"\n3. Vyberte stiahnutý súbor a importujte');

    setShowCalendarMenu(false);
  };

  // Copy ICS URL for subscription (if available)
  const showImportInstructions = () => {
    const instructions = `Návod na import do rôznych kalendárov:

📱 iOS / macOS (Apple Calendar):
1. Stiahnite .ics súbor
2. Otvorte súbor - automaticky sa otvorí v Kalendári
3. Potvrďte import

🖥️ Windows (Outlook):
1. Stiahnite .ics súbor
2. Dvojkliknite na súbor
3. Outlook automaticky importuje udalosti

🌐 Google Calendar (web):
1. Stiahnite .ics súbor
2. Otvorte calendar.google.com
3. Nastavenia (⚙️) > Import a export
4. Vyberte stiahnutý .ics súbor

📅 Outlook (web):
1. Stiahnite .ics súbor
2. Otvorte outlook.com > Kalendár
3. Pridať kalendár > Nahrať zo súboru`;

    alert(instructions);
    setShowCalendarMenu(false);
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'completed') return t.completed;
    if (filter === 'active') return !t.completed;
    if (filter === 'new') {
      return isNewOrModified(t) || hasNewOrModifiedSubtask(t.subtasks);
    }
    if (filter === 'high') {
      return (t.priority === 'high' && !t.completed) || hasSubtaskWithPriority(t.subtasks, 'high');
    }
    if (filter === 'medium') {
      return (t.priority === 'medium' && !t.completed) || hasSubtaskWithPriority(t.subtasks, 'medium');
    }
    if (filter === 'low') {
      return (t.priority === 'low' && !t.completed) || hasSubtaskWithPriority(t.subtasks, 'low');
    }
    if (filter === 'with-contact') {
      const hasContacts = (t.contactIds?.length > 0) || t.contactId;
      return hasContacts;
    }
    if (filter === 'without-contact') {
      const hasContacts = (t.contactIds?.length > 0) || t.contactId;
      return !hasContacts;
    }
    if (filter === 'due-success') {
      const taskMatches = !t.completed && getDueDateClass(t.dueDate, t.completed) === 'due-success';
      return taskMatches || hasSubtaskWithDueClass(t.subtasks, 'due-success');
    }
    if (filter === 'due-warning') {
      const taskMatches = !t.completed && getDueDateClass(t.dueDate, t.completed) === 'due-warning';
      return taskMatches || hasSubtaskWithDueClass(t.subtasks, 'due-warning');
    }
    if (filter === 'due-danger') {
      const taskMatches = !t.completed && getDueDateClass(t.dueDate, t.completed) === 'due-danger';
      return taskMatches || hasSubtaskWithDueClass(t.subtasks, 'due-danger');
    }
    if (filter === 'overdue') {
      const taskMatches = !t.completed && getDueDateClass(t.dueDate, t.completed) === 'overdue';
      return taskMatches || hasSubtaskWithDueClass(t.subtasks, 'overdue');
    }
    if (filter === 'assigned-to-me') {
      const userId = user?.id?.toString();
      if (!userId) return false;
      return (t.assignedTo || []).some(id => id?.toString() === userId);
    }
    return true;
  });

  const completedCount = tasks.filter(t => t.completed).length;
  const activeCount = tasks.filter(t => !t.completed).length;
  const newCount = countNewOrModified(tasks);
  const highPriorityCount = countWithPriority(tasks, 'high');
  const mediumPriorityCount = countWithPriority(tasks, 'medium');
  const lowPriorityCount = countWithPriority(tasks, 'low');
  const withContactCount = tasks.filter(t => (t.contactIds?.length > 0) || t.contactId).length;
  const withoutContactCount = tasks.filter(t => !((t.contactIds?.length > 0) || t.contactId)).length;
  const assignedToMeCount = tasks.filter(t => {
    const userId = user?.id?.toString();
    if (!userId) return false;
    return (t.assignedTo || []).some(id => id?.toString() === userId);
  }).length;
  const dueSuccessCount = countWithDueClass(tasks, 'due-success');
  const dueWarningCount = countWithDueClass(tasks, 'due-warning');
  const dueDangerCount = countWithDueClass(tasks, 'due-danger');
  const overdueCount = countWithDueClass(tasks, 'overdue');

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
          <div className="calendar-export-dropdown" ref={calendarMenuRef}>
            <button
              className="btn btn-secondary"
              onClick={() => setShowCalendarMenu(!showCalendarMenu)}
              title="Exportovať termíny do kalendára"
            >
              📅 Export ▾
            </button>
            {showCalendarMenu && (
              <div className="calendar-menu">
                <button onClick={() => downloadIcsFile({ incremental: true })} className="calendar-menu-item">
                  📥 Stiahnuť nové úlohy
                  <span className="menu-hint">Iba ešte neexportované</span>
                </button>
                <button onClick={() => downloadIcsFile()} className="calendar-menu-item">
                  📥 Stiahnuť všetky úlohy
                  <span className="menu-hint">Kompletný export</span>
                </button>
                <button onClick={() => downloadIcsFile({ reset: true })} className="calendar-menu-item">
                  🔄 Reset a stiahnuť všetko
                  <span className="menu-hint">Vymaže históriu exportu</span>
                </button>
                <div className="calendar-menu-separator"></div>
                <button onClick={openInGoogleCalendar} className="calendar-menu-item">
                  🌐 Google Calendar
                  <span className="menu-hint">Otvorí import stránku</span>
                </button>
                <button onClick={showImportInstructions} className="calendar-menu-item">
                  ❓ Návod na import
                  <span className="menu-hint">Pre všetky platformy</span>
                </button>
              </div>
            )}
          </div>
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

          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              <span className="stat-label">Celkom úloh</span>
              <span className="stat-value">{tasks.length}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'new' ? 'active' : ''}`}
              onClick={() => setFilter('new')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#8B5CF6' }}></span>
                Nové / Zmenené (24h)
              </span>
              <span className="stat-value">{newCount}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'active' ? 'active' : ''}`}
              onClick={() => setFilter('active')}
            >
              <span className="stat-label">Nesplnených</span>
              <span className="stat-value">{activeCount}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'completed' ? 'active' : ''}`}
              onClick={() => setFilter('completed')}
            >
              <span className="stat-label">Splnených</span>
              <span className="stat-value">{completedCount}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'with-contact' ? 'active' : ''}`}
              onClick={() => setFilter('with-contact')}
            >
              <span className="stat-label">S kontaktom</span>
              <span className="stat-value">{withContactCount}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'without-contact' ? 'active' : ''}`}
              onClick={() => setFilter('without-contact')}
            >
              <span className="stat-label">Bez kontaktu</span>
              <span className="stat-value">{withoutContactCount}</span>
            </div>
            <div
              className={`stat-item clickable ${filter === 'assigned-to-me' ? 'active' : ''}`}
              onClick={() => setFilter('assigned-to-me')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#3B82F6' }}></span>
                Priradené mne
              </span>
              <span className="stat-value">{assignedToMeCount}</span>
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Podľa priority</h4>
            <div
              className={`stat-item clickable priority-stat ${filter === 'high' ? 'active' : ''}`}
              onClick={() => setFilter('high')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#EF4444' }}></span>
                Vysoká priorita
              </span>
              <span className="stat-value">{highPriorityCount}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${filter === 'medium' ? 'active' : ''}`}
              onClick={() => setFilter('medium')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#F59E0B' }}></span>
                Stredná priorita
              </span>
              <span className="stat-value">{mediumPriorityCount}</span>
            </div>
            <div
              className={`stat-item clickable priority-stat ${filter === 'low' ? 'active' : ''}`}
              onClick={() => setFilter('low')}
            >
              <span className="stat-label">
                <span className="priority-dot" style={{ backgroundColor: '#10B981' }}></span>
                Nízka priorita
              </span>
              <span className="stat-value">{lowPriorityCount}</span>
            </div>

            <div className="sidebar-section-title">Termín</div>
            <div
              className={`stat-item clickable due-stat ${filter === 'due-success' ? 'active' : ''}`}
              onClick={() => setFilter('due-success')}
            >
              <span className="stat-label">
                <span className="priority-dot due-success-dot"></span>
                Do 14 dní
              </span>
              <span className="stat-value">{dueSuccessCount}</span>
            </div>
            <div
              className={`stat-item clickable due-stat ${filter === 'due-warning' ? 'active' : ''}`}
              onClick={() => setFilter('due-warning')}
            >
              <span className="stat-label">
                <span className="priority-dot due-warning-dot"></span>
                Do 7 dní
              </span>
              <span className="stat-value">{dueWarningCount}</span>
            </div>
            <div
              className={`stat-item clickable due-stat ${filter === 'due-danger' ? 'active' : ''}`}
              onClick={() => setFilter('due-danger')}
            >
              <span className="stat-label">
                <span className="priority-dot due-danger-dot"></span>
                Do 3 dní
              </span>
              <span className="stat-value">{dueDangerCount}</span>
            </div>
            <div
              className={`stat-item clickable due-stat ${filter === 'overdue' ? 'active' : ''}`}
              onClick={() => setFilter('overdue')}
            >
              <span className="stat-label">
                <span className="priority-dot overdue-dot"></span>
                Po termíne ⚠
              </span>
              <span className="stat-value">{overdueCount}</span>
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
                    <label>Priradiť ku kontaktom</label>
                    <div className="multi-select-contacts">
                      {contacts.map(contact => (
                        <label key={contact.id} className="contact-checkbox">
                          <input
                            type="checkbox"
                            checked={newTaskForm.contactIds.includes(contact.id)}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setNewTaskForm(prev => ({
                                ...prev,
                                contactIds: checked
                                  ? [...prev.contactIds, contact.id]
                                  : prev.contactIds.filter(id => id !== contact.id)
                              }));
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
                  <div className="form-group full-width">
                    <label>Priradiť používateľom</label>
                    <div className="multi-select-users">
                      {users.map(u => (
                        <label key={u.id} className="user-checkbox">
                          <input
                            type="checkbox"
                            checked={newTaskForm.assignedTo.includes(u.id)}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setNewTaskForm(prev => ({
                                ...prev,
                                assignedTo: checked
                                  ? [...prev.assignedTo, u.id]
                                  : prev.assignedTo.filter(id => id !== u.id)
                              }));
                            }}
                          />
                          <span
                            className="user-avatar-small"
                            style={{ backgroundColor: u.color }}
                          >
                            {u.username.charAt(0).toUpperCase()}
                          </span>
                          <span>{u.username}</span>
                          <span className="user-role-badge">{u.role === 'admin' ? 'Admin' : u.role === 'manager' ? 'Manažér' : 'Používateľ'}</span>
                        </label>
                      ))}
                    </div>
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
                <div className="due-date-legend">
                  <span className="legend-item">
                    <span className="legend-color due-success-color"></span>
                    <span>Do 14 dní</span>
                  </span>
                  <span className="legend-item">
                    <span className="legend-color due-warning-color"></span>
                    <span>Do 7 dní</span>
                  </span>
                  <span className="legend-item">
                    <span className="legend-color due-danger-color"></span>
                    <span>Do 3 dní</span>
                  </span>
                  <span className="legend-item">
                    <span className="legend-color overdue-color"></span>
                    <span>Po termíne ⚠</span>
                  </span>
                </div>
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
                    <div
                      key={task.id}
                      ref={el => taskRefs.current[task.id] = el}
                      className={`task-card ${task.completed ? 'completed' : ''} ${highlightedTaskId === task.id ? 'highlighted' : ''}`}
                    >
                      <div className="task-main">
                        <div
                          className="task-checkbox-styled"
                          onClick={() => !task.completed && toggleTask(task)}
                          style={{
                            borderColor: getPriorityColor(task.priority),
                            backgroundColor: task.completed ? getPriorityColor(task.priority) : 'transparent'
                          }}
                        >
                          {task.completed && '✓'}
                        </div>

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
                              <label>Kontakty</label>
                              <div className="multi-select-contacts compact">
                                {contacts.map(contact => (
                                  <label key={contact.id} className="contact-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={(editForm.contactIds || []).includes(contact.id)}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        setEditForm(prev => ({
                                          ...prev,
                                          contactIds: checked
                                            ? [...(prev.contactIds || []), contact.id]
                                            : (prev.contactIds || []).filter(id => id !== contact.id)
                                        }));
                                      }}
                                    />
                                    <span>{contact.name}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                            <div className="form-group">
                              <label>Priradení</label>
                              <div className="multi-select-users compact">
                                {users.map(u => (
                                  <label key={u.id} className="user-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={(editForm.assignedTo || []).includes(u.id)}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        setEditForm(prev => ({
                                          ...prev,
                                          assignedTo: checked
                                            ? [...(prev.assignedTo || []), u.id]
                                            : (prev.assignedTo || []).filter(id => id !== u.id)
                                        }));
                                      }}
                                    />
                                    <span className="user-dot" style={{ backgroundColor: u.color }}></span>
                                    <span>{u.username}</span>
                                  </label>
                                ))}
                              </div>
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
                                <span className={`due-date ${getDueDateClass(task.dueDate, task.completed)}`}>📅 {formatDate(task.dueDate)}</span>
                              )}
                              {(task.contactName || task.contactNames?.length > 0) && (
                                <span className="contact-badge">
                                  👤 {task.contactNames?.length > 0 ? task.contactNames.join(', ') : task.contactName}
                                </span>
                              )}
                              {task.subtasks?.length > 0 && (
                                <span className="subtask-count">
                                  ✓ {countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total}
                                </span>
                              )}
                              {task.assignedUsers?.length > 0 && (
                                <span className="assigned-users-badge">
                                  {task.assignedUsers.map(u => (
                                    <span
                                      key={u.id}
                                      className="assigned-user-avatar"
                                      style={{ backgroundColor: u.color }}
                                      title={u.username}
                                    >
                                      {u.username.charAt(0).toUpperCase()}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {editingTask !== task.id && (
                          <div className="task-actions">
                            <button onClick={() => openDuplicateModal(task)} className="btn-icon" title="Duplikovať">📋</button>
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

                            {!task.completed && (
                              <div className="add-subtask-wrapper">
                                <form onSubmit={(e) => addSubtask(e, task)} className="add-subtask-form">
                                  <input
                                    type="text"
                                    value={subtaskInputs[task.id] || ''}
                                    onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                                    placeholder="Pridať podúlohu..."
                                    className="form-input form-input-sm"
                                  />
                                  <input
                                    type="date"
                                    value={subtaskDueDates[task.id] || ''}
                                    onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [task.id]: e.target.value }))}
                                    className="form-input form-input-sm task-date-input"
                                    title="Termín podúlohy"
                                  />
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${showSubtaskNotesInput[task.id] ? 'active' : ''}`}
                                    onClick={() => setShowSubtaskNotesInput(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                                    title="Pridať poznámku"
                                  >
                                    📝
                                  </button>
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${showSubtaskAssignInput[task.id] ? 'active' : ''}`}
                                    onClick={() => setShowSubtaskAssignInput(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                                    title="Priradiť používateľom"
                                  >
                                    👤
                                  </button>
                                  <button type="submit" className="btn btn-secondary btn-sm">+</button>
                                </form>
                                {showSubtaskNotesInput[task.id] && (
                                  <textarea
                                    value={subtaskNotes[task.id] || ''}
                                    onChange={(e) => setSubtaskNotes(prev => ({ ...prev, [task.id]: e.target.value }))}
                                    placeholder="Poznámka k podúlohe..."
                                    className="form-input form-input-sm subtask-notes-input"
                                    rows={2}
                                  />
                                )}
                                {showSubtaskAssignInput[task.id] && (
                                  <div className="subtask-assign-users-form">
                                    {users.map(u => (
                                      <label key={u.id} className="subtask-user-checkbox">
                                        <input
                                          type="checkbox"
                                          checked={(subtaskAssignedTo[task.id] || []).includes(u.id)}
                                          onChange={(e) => {
                                            const checked = e.target.checked;
                                            setSubtaskAssignedTo(prev => ({
                                              ...prev,
                                              [task.id]: checked
                                                ? [...(prev[task.id] || []), u.id]
                                                : (prev[task.id] || []).filter(id => id !== u.id)
                                            }));
                                          }}
                                        />
                                        <span className="subtask-user-dot" style={{ backgroundColor: u.color }}></span>
                                        <span>{u.username}</span>
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
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

export default Tasks;
