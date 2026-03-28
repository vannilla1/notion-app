import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/api/api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import { useNavigate, useLocation } from 'react-router-dom';
import UserMenu from '../components/UserMenu';
import HelpGuide from '../components/HelpGuide';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import { DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';

// Help tips for Tasks page
const tasksHelpTips = [
  {
    icon: '➕',
    title: 'Vytvorenie projektu',
    description: 'Kliknite na "+ Nový projekt" pre vytvorenie nového projektu. Môžete ho priradiť ku kontaktu alebo vytvoriť globálny projekt.'
  },
  {
    icon: '📅',
    title: 'Termíny a priorita',
    description: 'Každému projektu môžete nastaviť termín dokončenia a prioritu (nízka, stredná, vysoká). Farebné označenie ukazuje blížiace sa termíny — zelená (do 14 dní), oranžová (do 7 dní), červená (po termíne).'
  },
  {
    icon: '🔔',
    title: 'Upozornenia na termíny',
    description: 'Systém automaticky sleduje termíny projektov a úloh. Dostanete notifikáciu 7 dní pred termínom, 3 dni pred termínom a keď termín vyprší. Pri nastavení termínu si môžete zvoliť vlastnú pripomienku (v deň termínu, 1, 3, 7 alebo 14 dní pred). Funguje aj cez push notifikácie na iOS.'
  },
  {
    icon: '📝',
    title: 'Úlohy',
    description: 'Rozbaľte projekt a pridajte úlohy pre lepšiu organizáciu. Úlohy môžu mať vlastné úlohy, termíny, poznámky a priradených používateľov. Kliknutím na názov úlohy rozbalíte jej úlohy.'
  },
  {
    icon: '✅',
    title: 'Dokončenie projektu',
    description: 'Kliknutím na checkbox označíte projekt ako dokončený. Pri dokončení hlavného projektu sa automaticky dokončia aj všetky jeho úlohy.'
  },
  {
    icon: '👤',
    title: 'Priradenie projektov',
    description: 'Projekty a úlohy môžete priradiť konkrétnym členom tímu. Priradený používateľ dostane notifikáciu v aplikácii aj push notifikáciu na mobile.'
  },
  {
    icon: '↕️',
    title: 'Radenie projektov',
    description: 'Projekty sa radia podľa priority (Vysoká → Stredná → Nízka). Dokončené projekty sa zobrazia na konci. Poradie môžete zmeniť aj pretiahnutím cez ikonu ⠿.'
  },
  {
    icon: '📎',
    title: 'Prílohy',
    description: 'K projektom a úlohám môžete priložiť súbory (max. 10 MB): obrázky (JPG, PNG, GIF, WebP), dokumenty (PDF, Word, Excel, PowerPoint), texty (TXT, CSV, JSON, XML), archívy (ZIP, RAR, 7z) a médiá (MP3, MP4, WAV, AVI, MOV).'
  },
  {
    icon: '🔍',
    title: 'Filtrovanie',
    description: 'Použite filtre v ľavom paneli: Všetky, Na dnes, Priradené mne, Nové (posledných 24h), alebo podľa priority. Filtre fungujú aj na úlohy.'
  },
  {
    icon: '🗓️',
    title: 'Kalendárový pohľad',
    description: 'Prepnite na pohľad kalendára tlačidlom 📅 vpravo hore. Vyberte si mesačný, týždenný alebo denný prehľad. Kliknutím na deň v mesačnom pohľade zobrazíte detailný denný pohľad. Na mobile sa kalendár dá horizontálne posúvať.'
  },
  {
    icon: '📥',
    title: 'Export do CSV',
    description: 'Kliknite na "📥 CSV" vedľa prepínača pohľadu pre stiahnutie všetkých projektov a úloh do tabuľkového súboru. Súbor sa otvorí v Exceli alebo Google Sheets so správnymi diakritikami.'
  },
  {
    icon: '📆',
    title: 'Google synchronizácia',
    description: 'V nastaveniach profilu prepojte Google Calendar a Google Tasks pre automatickú obojstrannú synchronizáciu termínov a projektov.'
  }
];

// Sortable wrapper for task cards
function SortableTaskItem({ id, children }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative'
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {children({ dragListeners: listeners, isDragging })}
    </div>
  );
}

// Sortable wrapper for subtasks
function SortableSubtaskItem({ id, children }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {children({ dragListeners: listeners, isDragging })}
    </div>
  );
}

// Calendar View Component
function CalendarView({ tasks, calendarMonth, setCalendarMonth, getDueDateClass, onTaskClick, loading }) {
  const [calendarMode, setCalendarMode] = useState('month'); // 'month', 'week', 'day'
  const [selectedDate, setSelectedDate] = useState(new Date());

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();

  const monthNames = ['Január', 'Február', 'Marec', 'Apríl', 'Máj', 'Jún', 'Júl', 'August', 'September', 'Október', 'November', 'December'];
  const dayNames = ['Po', 'Ut', 'St', 'Št', 'Pi', 'So', 'Ne'];
  const dayNamesFull = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota', 'Nedeľa'];

  // Collect all items with dueDates (tasks + subtasks)
  const collectDueDateItems = (taskList) => {
    const items = [];
    for (const task of taskList) {
      if (task.dueDate) {
        items.push({ id: task.id, title: task.title, dueDate: task.dueDate, completed: task.completed, type: 'task', task });
      }
      const collectSubtasks = (subtasks, parentTask) => {
        if (!subtasks) return;
        for (const sub of subtasks) {
          if (sub.dueDate) {
            items.push({ id: sub.id, title: sub.title, dueDate: sub.dueDate, completed: sub.completed, type: 'subtask', task: parentTask });
          }
          if (sub.subtasks) collectSubtasks(sub.subtasks, parentTask);
        }
      };
      collectSubtasks(task.subtasks, task);
    }
    return items;
  };

  const allItems = collectDueDateItems(tasks);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const isSameDay = (d1, d2) => d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();

  const getItemsForDate = (date) => {
    return allItems.filter(item => {
      const d = new Date(item.dueDate);
      return isSameDay(d, date);
    });
  };

  // Get Monday of the week containing selectedDate
  const getWeekStart = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  // Navigation
  const navigateCalendar = (dir) => {
    if (calendarMode === 'month') {
      setCalendarMonth(new Date(year, month + dir, 1));
    } else if (calendarMode === 'week') {
      const newDate = new Date(selectedDate);
      newDate.setDate(newDate.getDate() + dir * 7);
      setSelectedDate(newDate);
      setCalendarMonth(new Date(newDate.getFullYear(), newDate.getMonth(), 1));
    } else {
      const newDate = new Date(selectedDate);
      newDate.setDate(newDate.getDate() + dir);
      setSelectedDate(newDate);
      setCalendarMonth(new Date(newDate.getFullYear(), newDate.getMonth(), 1));
    }
  };

  const goToday = () => {
    const now = new Date();
    setSelectedDate(now);
    setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
  };

  // Get navigation label
  const getNavLabel = () => {
    if (calendarMode === 'month') {
      return `${monthNames[month]} ${year}`;
    } else if (calendarMode === 'week') {
      const weekStart = getWeekStart(selectedDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const startStr = `${weekStart.getDate()}.${weekStart.getMonth() + 1}.`;
      const endStr = `${weekEnd.getDate()}.${weekEnd.getMonth() + 1}.${weekEnd.getFullYear()}`;
      return `${startStr} – ${endStr}`;
    } else {
      const dayIdx = (selectedDate.getDay() + 6) % 7;
      return `${dayNamesFull[dayIdx]} ${selectedDate.getDate()}. ${monthNames[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`;
    }
  };

  if (loading) return <div className="loading">Načítavam...</div>;

  // --- MONTH VIEW ---
  const renderMonth = () => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = (firstDay.getDay() + 6) % 7;
    const daysInMonth = lastDay.getDate();

    const itemsByDay = {};
    for (const item of allItems) {
      const d = new Date(item.dueDate);
      if (d.getFullYear() === year && d.getMonth() === month) {
        const day = d.getDate();
        if (!itemsByDay[day]) itemsByDay[day] = [];
        itemsByDay[day].push(item);
      }
    }

    const cells = [];
    for (let i = 0; i < startDayOfWeek; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);

    return (
      <div className="calendar-grid">
        {dayNames.map(name => (
          <div key={name} className="calendar-day-header">{name}</div>
        ))}
        {cells.map((day, idx) => (
          <div
            key={idx}
            className={`calendar-cell ${day ? '' : 'empty'} ${day && new Date(year, month, day).getTime() === today.getTime() ? 'today' : ''}`}
            onClick={() => { if (day) { setSelectedDate(new Date(year, month, day)); setCalendarMode('day'); } }}
          >
            {day && (
              <>
                <span className="calendar-day-number">{day}</span>
                <div className="calendar-items">
                  {(itemsByDay[day] || []).slice(0, 3).map(item => (
                    <div
                      key={item.id}
                      className={`calendar-item ${getDueDateClass(item.dueDate, item.completed)} ${item.completed ? 'completed' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onTaskClick(item.task); }}
                      title={item.type === 'subtask' ? `${item.task.title} / ${item.title}` : item.title}
                    >
                      <div className="calendar-item-body">
                        {item.type === 'subtask' && (
                          <span className="calendar-item-project-badge">{item.task.title}</span>
                        )}
                        <span className="calendar-item-title">{item.title}</span>
                      </div>
                    </div>
                  ))}
                  {(itemsByDay[day] || []).length > 3 && (
                    <div className="calendar-more">+{(itemsByDay[day] || []).length - 3} ďalších</div>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    );
  };

  // --- WEEK VIEW ---
  const renderWeek = () => {
    const weekStart = getWeekStart(selectedDate);

    return (
      <div className="calendar-week-view">
        {Array.from({ length: 7 }, (_, i) => {
          const date = new Date(weekStart);
          date.setDate(date.getDate() + i);
          const items = getItemsForDate(date);
          const isCurrentDay = isSameDay(date, today);

          return (
            <div
              key={i}
              className={`calendar-week-day ${isCurrentDay ? 'today' : ''}`}
              onClick={() => { setSelectedDate(date); setCalendarMode('day'); }}
            >
              <div className="calendar-week-day-header">
                <span className="calendar-week-day-name">{dayNames[i]}</span>
                <span className={`calendar-week-day-number ${isCurrentDay ? 'today' : ''}`}>{date.getDate()}.{date.getMonth() + 1}.</span>
              </div>
              <div className="calendar-week-items">
                {items.map(item => (
                  <div
                    key={item.id}
                    className={`calendar-week-item ${getDueDateClass(item.dueDate, item.completed)} ${item.completed ? 'completed' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onTaskClick(item.task); }}
                  >
                    <div className="calendar-week-item-content">
                      {item.type === 'subtask' && (
                        <span className="calendar-week-item-project">{item.task.title}</span>
                      )}
                      <span className="calendar-week-item-title">{item.title}</span>
                    </div>
                  </div>
                ))}
                {items.length === 0 && <div className="calendar-week-empty">Žiadne termíny</div>}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // --- DAY VIEW ---
  const renderDay = () => {
    const items = getItemsForDate(selectedDate);

    return (
      <div className="calendar-day-view">
        {items.length === 0 && <div className="calendar-day-empty">Žiadne termíny na tento deň</div>}
        {items.map(item => (
          <div
            key={item.id}
            className={`calendar-day-item ${getDueDateClass(item.dueDate, item.completed)} ${item.completed ? 'completed' : ''}`}
            onClick={() => onTaskClick(item.task)}
          >
            <div className="calendar-day-item-header">
              <span className="calendar-day-item-type">{item.type === 'subtask' ? '↳ Úloha' : 'Projekt'}</span>
              {item.completed && <span className="calendar-day-item-done">✅</span>}
            </div>
            <span className="calendar-day-item-title">{item.title}</span>
            {item.task && item.type === 'subtask' && (
              <span className="calendar-day-item-parent">z: {item.task.title}</span>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="calendar-view">
      <div className="calendar-nav">
        <button className="btn btn-secondary btn-sm" onClick={() => navigateCalendar(-1)}>◀</button>
        <span className="calendar-month-label">{getNavLabel()}</span>
        <button className="btn btn-secondary btn-sm" onClick={() => navigateCalendar(1)}>▶</button>
        <button className="btn btn-secondary btn-sm calendar-today-btn" onClick={goToday}>Dnes</button>
      </div>
      <div className="calendar-mode-toggle">
        <button className={`btn btn-sm ${calendarMode === 'month' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCalendarMode('month')}>Mesiac</button>
        <button className={`btn btn-sm ${calendarMode === 'week' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCalendarMode('week')}>Týždeň</button>
        <button className={`btn btn-sm ${calendarMode === 'day' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCalendarMode('day')}>Deň</button>
      </div>
      {calendarMode === 'month' && (
        <div className="calendar-grid-scroll">
          {renderMonth()}
        </div>
      )}
      {calendarMode === 'week' && renderWeek()}
      {calendarMode === 'day' && renderDay()}
    </div>
  );
}

function Tasks() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tasks, setTasks] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [contactFilter, setContactFilter] = useState(null); // Filter by specific contact
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'calendar'
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [expandedTask, setExpandedTask] = useState(null);
  const { socket, isConnected } = useSocket();
  const [highlightedTaskId, setHighlightedTaskId] = useState(null);
  const [highlightedSubtaskId, setHighlightedSubtaskId] = useState(null);
  const taskRefs = useRef({});
  // Store pending highlight from navigation (for when tasks haven't loaded yet)
  const pendingHighlightRef = useRef(null);

  // Form states
  const [newTaskForm, setNewTaskForm] = useState({
    title: '',
    description: '',
    dueDate: '',
    priority: 'medium',
    contactIds: [],
    assignedTo: [],
    reminder: ''
  });

  // Edit states
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});

  // Subtask states
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [subtaskDueDates, setSubtaskDueDates] = useState({});
  const [subtaskNotes, setSubtaskNotes] = useState({});
  const [subtaskAssignedTo, setSubtaskAssignedTo] = useState({});
  const [showSubtaskDateInput, setShowSubtaskDateInput] = useState({});
  const [showSubtaskNotesInput, setShowSubtaskNotesInput] = useState({});
  const [showSubtaskAssignInput, setShowSubtaskAssignInput] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');
  const [editSubtaskNotes, setEditSubtaskNotes] = useState('');
  const [editSubtaskDueDate, setEditSubtaskDueDate] = useState('');
  const [editSubtaskAssignedTo, setEditSubtaskAssignedTo] = useState([]);
  const [expandedSubtasks, setExpandedSubtasks] = useState({});

  // File attachment states
  const [uploadingFile, setUploadingFile] = useState(null); // taskId or subtaskId being uploaded to
  const taskFileInputRef = useRef(null);
  const subtaskFileInputRef = useRef(null);
  const [activeFileTarget, setActiveFileTarget] = useState(null); // { taskId, subtaskId? }

  // Duplicate modal states
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [duplicatingTask, setDuplicatingTask] = useState(null);
  const [duplicateContactIds, setDuplicateContactIds] = useState([]);

  // Google Calendar notification
  const [googleCalendarNotification, setGoogleCalendarNotification] = useState(null);

  // Define fetch functions early so they can be used in useEffects
  const exportTasksCsv = () => {
    const token = localStorage.getItem('token');
    fetch(`${api.defaults.baseURL}/api/tasks/export/csv`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(response => response.blob())
      .then(blob => {
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = 'projekty.csv';
        link.click();
      })
      .catch(() => alert('Chyba pri exporte'));
  };

  const fetchTasks = useCallback(async () => {
    try {
      const res = await api.get('/api/tasks');
      setTasks(res.data);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchContacts = useCallback(async () => {
    try {
      const res = await api.get('/api/contacts');
      setContacts(res.data);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await api.get('/api/auth/users');
      setUsers(res.data);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    }
  }, []);

  // Sync completed tasks from Google Tasks to CRM
  const syncCompletedFromGoogle = useCallback(async () => {
    try {
      // This will silently sync completed tasks from Google Tasks
      // No UI feedback needed - it runs in background
      await api.post('/api/google-tasks/sync-completed');
      // Refresh tasks after sync to show updated completion status
      fetchTasks();
    } catch (error) {
      // Silently ignore errors (user may not have Google Tasks connected)
      console.log('Google Tasks sync skipped:', error.response?.data?.message || error.message);
    }
  }, [fetchTasks]);

  useEffect(() => {
    fetchTasks();
    fetchContacts();
    fetchUsers();
    // Sync completed tasks from Google Tasks (if connected)
    syncCompletedFromGoogle();
  }, [fetchTasks, fetchContacts, fetchUsers, syncCompletedFromGoogle]);

  // Handle Google Calendar and Google Tasks OAuth callback parameters
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const googleCalendarStatus = params.get('google_calendar');
    const googleTasksStatus = params.get('google_tasks');
    const errorMessage = params.get('message');

    if (googleCalendarStatus) {
      if (googleCalendarStatus === 'connected') {
        setGoogleCalendarNotification({
          type: 'success',
          message: 'Google Calendar bol úspešne pripojený!'
        });
      } else if (googleCalendarStatus === 'error') {
        setGoogleCalendarNotification({
          type: 'error',
          message: `Chyba pri pripájaní Google Calendar: ${errorMessage || 'Neznáma chyba'}`
        });
      }

      // Clear URL parameters
      navigate('/tasks', { replace: true });

      // Auto-hide notification after 5 seconds
      setTimeout(() => {
        setGoogleCalendarNotification(null);
      }, 5000);
    }

    if (googleTasksStatus) {
      if (googleTasksStatus === 'connected') {
        setGoogleCalendarNotification({
          type: 'success',
          message: 'Google Tasks bol úspešne pripojený! Projekty sa budú automaticky synchronizovať.'
        });
      } else if (googleTasksStatus === 'error') {
        setGoogleCalendarNotification({
          type: 'error',
          message: `Chyba pri pripájaní Google Tasks: ${errorMessage || 'Neznáma chyba'}`
        });
      }

      // Clear URL parameters
      navigate('/tasks', { replace: true });

      // Auto-hide notification after 5 seconds
      setTimeout(() => {
        setGoogleCalendarNotification(null);
      }, 5000);
    }
  }, [location.search, navigate]);

  // Handle contact filter from URL (when navigating from CRM)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const contactId = params.get('contactId');

    if (contactId) {
      setContactFilter(contactId);
      // Clear URL parameter but keep the filter active
      navigate('/tasks', { replace: true });
    }
  }, [location.search, navigate]);

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

  // Check if current filter is assigned-to-me filter
  const isAssignedFilter = (f) => f === 'assigned-to-me';

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

  // Get IDs of subtasks assigned to user (recursive)
  const getAssignedSubtaskIds = (subtasks, userId) => {
    const ids = new Set();
    if (!subtasks || subtasks.length === 0 || !userId) return ids;
    for (const subtask of subtasks) {
      if ((subtask.assignedTo || []).some(id => id?.toString() === userId)) {
        ids.add(subtask.id);
      }
      if (subtask.subtasks) {
        const childIds = getAssignedSubtaskIds(subtask.subtasks, userId);
        childIds.forEach(id => ids.add(id));
      }
    }
    return ids;
  };

  // Check if any subtask is assigned to user (recursive)
  const hasAssignedSubtask = (subtasks, userId) => {
    if (!subtasks || subtasks.length === 0 || !userId) return false;
    for (const subtask of subtasks) {
      if ((subtask.assignedTo || []).some(id => id?.toString() === userId)) return true;
      if (subtask.subtasks && hasAssignedSubtask(subtask.subtasks, userId)) return true;
    }
    return false;
  };

  // Get IDs of parent subtasks that need to be expanded to show assigned children
  const getAssignedParentSubtaskIds = (subtasks, userId, parentIds = new Set()) => {
    if (!subtasks || subtasks.length === 0 || !userId) return parentIds;
    for (const subtask of subtasks) {
      if (subtask.subtasks && subtask.subtasks.length > 0) {
        const hasAssignedChild = hasAssignedSubtask(subtask.subtasks, userId);
        const selfAssigned = (subtask.assignedTo || []).some(id => id?.toString() === userId);
        if (hasAssignedChild || selfAssigned) {
          parentIds.add(subtask.id);
        }
        getAssignedParentSubtaskIds(subtask.subtasks, userId, parentIds);
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

  // Handle highlight from navigation state OR URL query params (push notification click)
  // Track navTimestamp to detect new navigation even when on same page
  const lastNavTimestampRef = useRef(null);

  // Helper function to process highlight
  const processHighlight = useCallback((taskId, subtaskId) => {
    console.log('[Tasks] processHighlight called:', taskId, subtaskId, 'tasks loaded:', tasks.length);

    if (tasks.length > 0) {
      setHighlightedTaskId(taskId);
      setExpandedTask(taskId);

      if (subtaskId) {
        setHighlightedSubtaskId(subtaskId);
        setExpandedSubtasks(prev => ({ ...prev, [subtaskId]: true }));
      }

      setTimeout(() => {
        if (taskRefs.current[taskId]) {
          taskRefs.current[taskId].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);

      setTimeout(() => {
        setHighlightedTaskId(null);
        setHighlightedSubtaskId(null);
      }, 3000);
    } else {
      // Tasks not loaded yet, store for later
      pendingHighlightRef.current = { taskId, subtaskId };
    }
  }, [tasks.length]);

  // Listen for custom event from App.jsx (when notification clicked while on this page)
  useEffect(() => {
    const handleTaskHighlight = async (event) => {
      console.log('[Tasks] Received task-highlight event:', event.detail);
      const { taskId, subtaskId, timestamp } = event.detail;
      if (timestamp && timestamp.toString() !== lastNavTimestampRef.current) {
        lastNavTimestampRef.current = timestamp.toString();

        // Refresh tasks first to get latest data
        console.log('[Tasks] Refreshing tasks before highlight...');
        await fetchTasks();

        // Then highlight the task (with small delay to ensure state updated)
        setTimeout(() => {
          processHighlight(taskId, subtaskId);
        }, 100);
      }
    };

    window.addEventListener('task-highlight', handleTaskHighlight);
    return () => window.removeEventListener('task-highlight', handleTaskHighlight);
  }, [processHighlight, fetchTasks]);

  useEffect(() => {
    // Check URL query params first (from service worker navigate)
    const params = new URLSearchParams(location.search);
    const urlTaskId = params.get('highlightTask');
    const urlSubtaskId = params.get('subtask');
    const urlTimestamp = params.get('_t');

    if (urlTaskId && urlTimestamp) {
      // Check if this is a new navigation
      if (urlTimestamp !== lastNavTimestampRef.current) {
        lastNavTimestampRef.current = urlTimestamp;
        // Clear query params from URL
        navigate(location.pathname, { replace: true, state: {} });
        processHighlight(urlTaskId, urlSubtaskId);
        return;
      }
    }

    // Fallback: Check navigation state (from postMessage)
    if (location.state?.highlightTaskId) {
      const currentTimestamp = location.state.navTimestamp?.toString();
      if (currentTimestamp && currentTimestamp !== lastNavTimestampRef.current) {
        lastNavTimestampRef.current = currentTimestamp;
        // Clear the navigation state immediately
        navigate(location.pathname, { replace: true, state: {} });
        processHighlight(location.state.highlightTaskId, location.state.highlightSubtaskId);
      }
    }
  }, [location.search, location.state, navigate, location.pathname, tasks.length]);

  // Process pending highlight when tasks are loaded
  useEffect(() => {
    if (pendingHighlightRef.current && tasks.length > 0) {
      const { taskId, subtaskId } = pendingHighlightRef.current;
      pendingHighlightRef.current = null; // Clear pending highlight

      setHighlightedTaskId(taskId);
      setExpandedTask(taskId);

      // If subtask is specified, highlight it and expand parent subtasks
      if (subtaskId) {
        setHighlightedSubtaskId(subtaskId);
        // Auto-expand subtasks to show the highlighted one
        setExpandedSubtasks(prev => ({ ...prev, [subtaskId]: true }));
      }

      // Scroll to the task after a short delay
      setTimeout(() => {
        if (taskRefs.current[taskId]) {
          taskRefs.current[taskId].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);

      // Remove highlight after 3 seconds
      setTimeout(() => {
        setHighlightedTaskId(null);
        setHighlightedSubtaskId(null);
      }, 3000);
    }
  }, [tasks]);

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

  // Track if filter just changed (to trigger auto-expand only on filter change, not on task updates)
  const prevFilterRef = useRef(filter);

  // Auto-expand tasks and subtasks when due date filter, 'new' filter, or 'assigned-to-me' filter is active
  // Only triggers on filter CHANGE, not on tasks update
  useEffect(() => {
    // Only run if filter actually changed
    const filterChanged = prevFilterRef.current !== filter;
    prevFilterRef.current = filter;

    if (!filterChanged) return;
    if ((!isDueDateFilter(filter) && filter !== 'new' && !isAssignedFilter(filter)) || tasks.length === 0) return;

    const tasksToExpand = new Set();
    const subtasksToExpand = {};
    const currentUserId = user?.id?.toString();

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
    } else if (isAssignedFilter(filter)) {
      // Handle assigned-to-me filter
      if (currentUserId) {
        for (const task of tasks) {
          const taskAssigned = (task.assignedTo || []).some(id => id?.toString() === currentUserId);
          const hasAssignedSubs = hasAssignedSubtask(task.subtasks, currentUserId);

          if (taskAssigned || hasAssignedSubs) {
            tasksToExpand.add(task.id);

            if (hasAssignedSubs) {
              const parentIds = getAssignedParentSubtaskIds(task.subtasks, currentUserId);
              parentIds.forEach(id => {
                subtasksToExpand[id] = true;
              });
            }
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
  }, [filter, tasks, user]);

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
        assignedTo: [],
        reminder: ''
      });
      setShowForm(false);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní projektu');
    }
  };

  const toggleTask = async (task) => {
    if (!task.completed) {
      if (!window.confirm(`Naozaj chcete označiť projekt "${task.title}" ako dokončený?`)) return;
    }
    try {
      await api.put(`/api/tasks/${task.id}`, {
        completed: !task.completed,
        source: task.source
      });
      await fetchTasks();
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (task) => {
    if (!window.confirm(`Naozaj chcete vymazať projekt "${task.title}"?`)) return;
    try {
      await api.delete(`/api/tasks/${task.id}?source=${task.source || 'global'}`);
      await fetchTasks();
    } catch (error) {
      console.error('Failed to delete task:', error);
      alert('Chyba pri mazaní projektu');
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
      alert(error.response?.data?.message || 'Chyba pri duplikovaní projektu');
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
      reminder: task.reminder != null ? String(task.reminder) : '',
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
      alert(error.response?.data?.message || 'Chyba pri ukladaní projektu');
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
      alert(error.response?.data?.message || 'Chyba pri vytvarani ulohy');
    }
  };

  const toggleSubtask = async (task, subtask) => {
    if (!subtask.completed) {
      if (!window.confirm(`Naozaj chcete označiť úlohu "${subtask.title}" ako dokončenú?`)) return;
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
    if (!window.confirm(`Naozaj chcete vymazať úlohu "${subtask.title}"?`)) return;
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
      alert(error.response?.data?.message || 'Chyba pri ukladani ulohy');
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

  // Recursively expand/collapse a subtask and all its children
  const toggleSubtaskCascade = (subtask) => {
    const isCurrentlyExpanded = expandedSubtasks[subtask.id];
    const ids = [];
    const collectIds = (st) => {
      ids.push(st.id);
      if (st.subtasks) st.subtasks.forEach(collectIds);
    };
    collectIds(subtask);
    setExpandedSubtasks(prev => {
      const next = { ...prev };
      ids.forEach(id => {
        next[id] = !isCurrentlyExpanded;
      });
      return next;
    });
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
    const isAssigned = isAssignedFilter(filter);
    const currentUserId = user?.id?.toString();

    // Sort subtasks by order
    const sortedSubtasks = [...subtasks].sort((a, b) => (a.order || 0) - (b.order || 0));
    // Key changes when order changes, forcing DndContext remount to prevent visual snap-back
    const dndKey = sortedSubtasks.map(s => s.id).join(',');

    return (
      <DndContext key={dndKey} sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} autoScroll={false} onDragEnd={(e) => handleSubtaskDragEnd(task, sortedSubtasks, e)}>
        <SortableContext items={sortedSubtasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
          {sortedSubtasks.map(subtask => {
      const hasChildren = subtask.subtasks && subtask.subtasks.length > 0;
      const isExpanded = expandedSubtasks[subtask.id];
      const childCounts = hasChildren ? countSubtasksRecursive(subtask.subtasks) : { total: 0, completed: 0 };

      // Check if this subtask matches the current filter (due date, new, or assigned)
      const matchesDueFilter = currentDueClass && !subtask.completed &&
        getDueDateClass(subtask.dueDate, subtask.completed) === currentDueClass;
      const matchesNewFilter = isNewFilter && isSubtaskNewOrModified(subtask);
      const matchesAssignedFilter = isAssigned && currentUserId &&
        (subtask.assignedTo || []).some(id => id?.toString() === currentUserId);
      const matchesFilter = matchesDueFilter || matchesNewFilter || matchesAssignedFilter;

      return (
        <SortableSubtaskItem key={subtask.id} id={subtask.id}>
          {({ dragListeners, isDragging }) => (
        <div className={`subtask-tree-item ${isDragging ? 'dragging' : ''}`} style={{ marginLeft: depth * 16 }}>
          <div
            className={`subtask-item ${subtask.completed ? 'completed' : ''} ${matchesFilter ? 'filter-match' : ''} ${highlightedSubtaskId === subtask.id ? 'highlighted' : ''}`}
            onClick={(e) => {
              if (e.target.closest('.subtask-checkbox-styled, .drag-handle, .subtask-actions, .btn-icon-sm, .subtask-edit-form-full, .subtask-expand-btn')) return;
              if (editingSubtask?.subtaskId === subtask.id) return;
              // Toggle cascade expand/collapse if has children
              if (hasChildren) toggleSubtaskCascade(subtask);
            }}
          >
            <span className="drag-handle subtask-drag-handle" {...dragListeners}>⠿</span>
            <div
              className="subtask-checkbox-styled"
              onClick={() => (!subtask.completed || user?.role === 'admin') && toggleSubtask(task, subtask)}
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
                    placeholder="Názov úlohy"
                  />
                </div>
                <div className="subtask-edit-row">
                  <input
                    type="date"
                    value={editSubtaskDueDate}
                    onChange={(e) => setEditSubtaskDueDate(e.target.value)}
                    className="form-input form-input-sm task-date-input"
                    title="Termín úlohy"
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
                  title="Klikni pre úpravu"
                >
                  {subtask.title}
                </span>
                {subtask.notes && (
                  <span className="subtask-notes-indicator" title={subtask.notes}>📝</span>
                )}
                {subtask.files?.length > 0 && (
                  <span className="subtask-notes-indicator" title={`${subtask.files.length} príloha`}>📎{subtask.files.length > 1 ? subtask.files.length : ''}</span>
                )}
                {subtask.dueDate && (
                  <span className={`subtask-due-date ${getDueDateClass(subtask.dueDate, subtask.completed)}`}>
                    {getDueDateClass(subtask.dueDate, subtask.completed) === 'overdue' ? '⚠️' : '📅'} {new Date(subtask.dueDate).toLocaleDateString('sk-SK')}
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
                    onClick={() => triggerFileUpload(task.id || task._id, subtask.id)}
                    className="btn-icon-sm"
                    title="Pridať prílohu"
                    disabled={uploadingFile === subtask.id}
                  >
                    {uploadingFile === subtask.id ? '⏳' : '📎'}
                  </button>
                  <button
                    onClick={() => {
                      setExpandedSubtasks(prev => ({ ...prev, [subtask.id]: true }));
                      setSubtaskInputs(prev => ({ ...prev, [subtask.id]: '' }));
                    }}
                    className="btn-icon-sm btn-add-child"
                    title="Pridat ulohu"
                  >
                    +
                  </button>
                  <button onClick={() => startEditSubtask(task, subtask)} className="btn-icon-sm" title="Upravit">✏️</button>
                  <button onClick={() => deleteSubtask(task, subtask)} className="btn-icon-sm btn-delete" title="Vymazat">×</button>
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

          {/* Subtask files */}
          {subtask.files?.length > 0 && (
            <div className="subtask-files-list" style={{ marginLeft: depth * 16 + 24 }}>
              {subtask.files.map(file => (
                <div key={file.id} className="task-file-item task-file-item-sm">
                  <span className="task-file-icon">{getFileIcon(file.mimetype)}</span>
                  <span className="task-file-name" title={file.originalName}>{file.originalName}</span>
                  <span className="task-file-size">{formatFileSize(file.size)}</span>
                  <button className="btn-icon-sm" onClick={() => handleFileDownload(task.id || task._id, file.id, file.originalName, subtask.id)} title="Stiahnuť">⬇️</button>
                  <button className="btn-icon-sm btn-delete" onClick={() => handleFileDelete(task.id || task._id, file.id, subtask.id)} title="Vymazať">×</button>
                </div>
              ))}
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
                  placeholder="Nová úloha..."
                  className="form-input form-input-sm"
                  autoFocus
                />
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm ${showSubtaskDateInput[subtask.id] ? 'active' : ''}`}
                  onClick={() => setShowSubtaskDateInput(prev => ({ ...prev, [subtask.id]: !prev[subtask.id] }))}
                  title="Termín"
                >
                  📅
                </button>
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
                <button type="submit" className="btn btn-primary btn-sm add-subtask-submit" title="Uložiť úlohu (Enter)"><span className="desktop-only">+</span><span className="ios-only">Uložiť</span></button>
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
                    setShowSubtaskDateInput(prev => ({ ...prev, [subtask.id]: false }));
                    setShowSubtaskNotesInput(prev => ({ ...prev, [subtask.id]: false }));
                    setShowSubtaskAssignInput(prev => ({ ...prev, [subtask.id]: false }));
                    setSubtaskAssignedTo(prev => ({ ...prev, [subtask.id]: [] }));
                  }}
                >
                  Zrušiť
                </button>
              </form>
              {showSubtaskDateInput[subtask.id] && (
                <input
                  type="date"
                  value={subtaskDueDates[subtask.id] || ''}
                  onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                  className="form-input form-input-sm"
                  autoFocus
                />
              )}
              {showSubtaskNotesInput[subtask.id] && (
                <textarea
                  value={subtaskNotes[subtask.id] || ''}
                  onChange={(e) => setSubtaskNotes(prev => ({ ...prev, [subtask.id]: e.target.value }))}
                  placeholder="Poznámka k úlohe..."
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
          )}
        </SortableSubtaskItem>
      );
    })}
        </SortableContext>
      </DndContext>
    );
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

  // File attachment handlers
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

  const handleFileUpload = async (taskId, subtaskId, file) => {
    const key = subtaskId || taskId;
    setUploadingFile(key);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const url = subtaskId
        ? `/api/tasks/${taskId}/files?subtaskId=${subtaskId}`
        : `/api/tasks/${taskId}/files`;
      await api.post(url, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 });
      await fetchTasks();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri nahrávaní súboru');
    } finally {
      setUploadingFile(null);
    }
  };

  const handleFileDownload = async (taskId, fileId, fileName, subtaskId) => {
    try {
      const url = subtaskId
        ? `/api/tasks/${taskId}/files/${fileId}/download?subtaskId=${subtaskId}`
        : `/api/tasks/${taskId}/files/${fileId}/download`;
      const response = await api.get(url, { responseType: 'blob' });
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(response.data);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
    } catch (error) {
      alert('Chyba pri sťahovaní súboru');
    }
  };

  const handleFileDelete = async (taskId, fileId, subtaskId) => {
    if (!window.confirm('Vymazať tento súbor?')) return;
    try {
      const url = subtaskId
        ? `/api/tasks/${taskId}/files/${fileId}?subtaskId=${subtaskId}`
        : `/api/tasks/${taskId}/files/${fileId}`;
      await api.delete(url);
      await fetchTasks();
    } catch (error) {
      alert('Chyba pri mazaní súboru');
    }
  };

  const triggerFileUpload = (taskId, subtaskId) => {
    setActiveFileTarget({ taskId, subtaskId });
    setTimeout(() => {
      const ref = subtaskId ? subtaskFileInputRef : taskFileInputRef;
      ref.current?.click();
    }, 0);
  };

  const onFileSelected = (e, isSubtask) => {
    const file = e.target.files[0];
    if (!file || !activeFileTarget) return;
    handleFileUpload(activeFileTarget.taskId, activeFileTarget.subtaskId, file);
    e.target.value = '';
  };

  // Helper to check if task or any uncompleted subtask is assigned to user
  const isAssignedToUser = (task, userId) => {
    // Check main task (only if not completed)
    if (!task.completed && (task.assignedTo || []).some(id => id?.toString() === userId)) return true;
    // Check subtasks recursively (only uncompleted)
    const checkSubtasks = (subtasks) => {
      if (!subtasks) return false;
      for (const sub of subtasks) {
        if (!sub.completed && (sub.assignedTo || []).some(id => id?.toString() === userId)) return true;
        if (sub.subtasks && checkSubtasks(sub.subtasks)) return true;
      }
      return false;
    };
    return checkSubtasks(task.subtasks);
  };

  // Helper to search in subtasks recursively
  const searchInSubtasks = (subtasks, query) => {
    if (!subtasks || !Array.isArray(subtasks)) return false;
    return subtasks.some(st => {
      const titleMatch = st.title?.toLowerCase().includes(query);
      const notesMatch = st.notes?.toLowerCase().includes(query);
      if (titleMatch || notesMatch) return true;
      return searchInSubtasks(st.subtasks, query);
    });
  };

  const filteredTasks = tasks.filter(t => {
    // First apply contact filter (from CRM navigation)
    if (contactFilter) {
      const taskContactIds = t.contactIds || (t.contactId ? [t.contactId] : []);
      if (!taskContactIds.includes(contactFilter)) return false;
    }

    // Then apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      const titleMatch = t.title?.toLowerCase().includes(query);
      const descMatch = t.description?.toLowerCase().includes(query);
      const contactMatch = t.contactName?.toLowerCase().includes(query);
      const subtaskMatch = searchInSubtasks(t.subtasks, query);
      if (!titleMatch && !descMatch && !contactMatch && !subtaskMatch) return false;
    }

    // Then apply status/priority filter
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
      return isAssignedToUser(t, userId);
    }
    return true;
  });

  // Sort tasks: incomplete first, then by priority (high→medium→low), then by order, completed at the end
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sortedFilteredTasks = [...filteredTasks].sort((a, b) => {
    const aCompleted = a.completed === true;
    const bCompleted = b.completed === true;
    if (aCompleted && !bCompleted) return 1;
    if (!aCompleted && bCompleted) return -1;
    // Within same completion status, sort by priority
    const priA = priorityOrder[a.priority] ?? 1;
    const priB = priorityOrder[b.priority] ?? 1;
    if (priA !== priB) return priA - priB;
    // Then by order
    const orderA = a.order || 0;
    const orderB = b.order || 0;
    if (orderA !== orderB) return orderA - orderB;
    return 0;
  });

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  // Handle task drag end
  const handleTaskDragEnd = useCallback(async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedFilteredTasks.findIndex(t => (t.id || t._id) === active.id);
    const newIndex = sortedFilteredTasks.findIndex(t => (t.id || t._id) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sortedFilteredTasks, oldIndex, newIndex);

    // Build order map
    const orderMap = {};
    reordered.forEach((t, idx) => { orderMap[t.id || t._id] = idx; });

    // Optimistic update using functional form
    setTasks(prev => prev.map(t => {
      const tid = t.id || t._id;
      if (orderMap[tid] !== undefined) return { ...t, order: orderMap[tid] };
      return t;
    }));

    // Save to server
    try {
      const reorderData = reordered.map((t, idx) => ({
        id: t.id || t._id,
        order: idx,
        source: t.source || 'global',
        contactId: t.contactId || null
      }));
      await api.put('/api/tasks/reorder', { tasks: reorderData });
    } catch (err) {
      console.error('Reorder failed:', err);
    }
  }, [sortedFilteredTasks]);

  // Handle subtask drag end
  const handleSubtaskDragEnd = useCallback(async (task, parentSubtasks, event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = parentSubtasks.findIndex(s => s.id === active.id);
    const newIndex = parentSubtasks.findIndex(s => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(parentSubtasks, oldIndex, newIndex);

    // Build order map from new positions
    const orderMap = {};
    reordered.forEach((s, idx) => { orderMap[s.id] = idx; });

    // Deep update subtask order in task's subtask tree
    const deepUpdateOrder = (subtasks) => {
      return subtasks.map(s => {
        const newOrder = orderMap[s.id];
        const updated = newOrder !== undefined ? { ...s, order: newOrder } : { ...s };
        if (updated.subtasks && updated.subtasks.length > 0) {
          updated.subtasks = deepUpdateOrder(updated.subtasks);
        }
        return updated;
      });
    };

    // Synchronous state update - must happen before DnD animation completes
    const taskId = task.id || task._id;
    setTasks(prev => {
      const newTasks = prev.map(t => {
        if ((t.id || t._id) === taskId) {
          return { ...t, subtasks: deepUpdateOrder(t.subtasks) };
        }
        return t;
      });
      return newTasks;
    });

    // Save to server (fire and forget, don't rollback on error to avoid visual glitch)
    try {
      const subtaskOrders = reordered.map((s, idx) => ({ id: s.id, order: idx }));
      await api.put('/api/tasks/reorder-subtasks', {
        taskId: taskId,
        source: task.source || 'global',
        contactId: task.contactId || null,
        subtasks: subtaskOrders
      });
    } catch (err) {
      console.error('Subtask reorder failed:', err);
    }
  }, []);

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
    return isAssignedToUser(t, userId);
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
          <h1 className="header-title-link" onClick={() => navigate('/app')}><img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />Prpl CRM</h1>
        </div>
        <div className="crm-header-right">
          <WorkspaceSwitcher />
          <button
            className="btn btn-secondary btn-nav-contacts"
            onClick={() => navigate('/crm')}
          >
            Kontakty
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

      {/* Google Calendar notification */}
      {googleCalendarNotification && (
        <div className={`notification notification-${googleCalendarNotification.type}`}>
          {googleCalendarNotification.message}
          <button
            className="notification-close"
            onClick={() => setGoogleCalendarNotification(null)}
          >
            ×
          </button>
        </div>
      )}

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
            + Nový projekt
          </button>

          <div className="dashboard-stats">
            <h3>Prehľad</h3>
            <div
              className={`stat-item clickable ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              <span className="stat-label">Celkom projektov</span>
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
              <h2>Nový projekt</h2>
              <form onSubmit={createTask} className="contact-form">
                <div className="contact-form-grid">
                  <div className="form-group full-width">
                    <label>Názov *</label>
                    <input
                      type="text"
                      value={newTaskForm.title}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, title: e.target.value })}
                      placeholder="Názov projektu"
                      className="form-input"
                      required
                    />
                  </div>
                  <div className="form-group full-width">
                    <label>Popis</label>
                    <textarea
                      value={newTaskForm.description}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, description: e.target.value })}
                      placeholder="Popis projektu..."
                      className="form-input"
                      rows={3}
                    />
                  </div>
                  <div className="form-group">
                    <label>Termín</label>
                    <input
                      type="date"
                      value={newTaskForm.dueDate}
                      onChange={(e) => setNewTaskForm({ ...newTaskForm, dueDate: e.target.value, reminder: e.target.value ? newTaskForm.reminder : '' })}
                      className="form-input"
                    />
                  </div>
                  {newTaskForm.dueDate && (
                    <div className="form-group">
                      <label>🔔 Pripomenúť</label>
                      <select
                        value={newTaskForm.reminder}
                        onChange={(e) => setNewTaskForm({ ...newTaskForm, reminder: e.target.value })}
                        className="form-input"
                      >
                        <option value="">Bez pripomienky</option>
                        <option value="0">V deň termínu</option>
                        <option value="1">1 deň pred</option>
                        <option value="3">3 dni pred</option>
                        <option value="7">7 dní pred</option>
                        <option value="14">14 dní pred</option>
                      </select>
                    </div>
                  )}
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
                    Vytvoriť projekt
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="tasks-page">
              {/* Contact filter banner */}
              {contactFilter && (
                <div className="contact-filter-banner">
                  <span>
                    Projekty pre kontakt: <strong>{contacts.find(c => c.id === contactFilter)?.name || 'Načítavam...'}</strong>
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setContactFilter(null)}
                  >
                    × Zrušiť filter
                  </button>
                </div>
              )}
              <div className="tasks-header">
                <div className="tasks-header-top">
                  <h2>{viewMode === 'list' ? `Zoznam projektov (${sortedFilteredTasks.length})` : 'Kalendár termínov'}</h2>
                  <div className="view-toggle">
                    <button
                      className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                      onClick={() => setViewMode('list')}
                      title="Zoznam"
                    >
                      ☰
                    </button>
                    <button
                      className={`view-toggle-btn ${viewMode === 'calendar' ? 'active' : ''}`}
                      onClick={() => setViewMode('calendar')}
                      title="Kalendár"
                    >
                      📅
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={exportTasksCsv}
                      title="Exportovať do CSV"
                      style={{ marginLeft: '8px' }}
                    >
                      📥 CSV
                    </button>
                  </div>
                </div>
                <div className="search-box">
                  <input
                    type="text"
                    placeholder="Hľadať projekt..."
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

              {viewMode === 'calendar' ? (
                <CalendarView
                  tasks={sortedFilteredTasks}
                  calendarMonth={calendarMonth}
                  setCalendarMonth={setCalendarMonth}
                  getDueDateClass={getDueDateClass}
                  onTaskClick={(task) => {
                    setViewMode('list');
                    setExpandedTask(task.id);
                    setTimeout(() => {
                      const el = document.querySelector(`[data-task-id="${task.id}"]`);
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                  }}
                  loading={loading}
                />
              ) : loading ? (
                <div className="loading">Načítavam...</div>
              ) : sortedFilteredTasks.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📋</div>
                  <h2>Žiadne projekty</h2>
                  <p>Začnite pridaním vášho prvého projektu</p>
                  <button
                    className="btn btn-primary empty-state-btn"
                    onClick={() => setShowForm(true)}
                  >
                    + Nový projekt
                  </button>
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} autoScroll={false} onDragEnd={handleTaskDragEnd}>
                  <SortableContext items={sortedFilteredTasks.map(t => t.id || t._id)} strategy={verticalListSortingStrategy}>
                <div className="tasks-list">
                  {sortedFilteredTasks.map(task => {
                    // Check if main task matches assigned filter
                    const currentUserId = user?.id?.toString();
                    const taskMatchesAssigned = isAssignedFilter(filter) && currentUserId &&
                      (task.assignedTo || []).some(id => id?.toString() === currentUserId);

                    return (
                    <SortableTaskItem key={task.id} id={task.id || task._id}>
                      {({ dragListeners, isDragging }) => (
                    <div
                      ref={el => taskRefs.current[task.id] = el}
                      className={`task-card ${task.completed ? 'completed' : ''} ${highlightedTaskId === task.id ? 'highlighted' : ''} ${taskMatchesAssigned ? 'filter-match' : ''} ${isDragging ? 'dragging' : ''}`}
                    >
                      <div className="task-main" onClick={(e) => {
                        // Only expand if clicking on the main area, not on buttons/checkbox/drag handle
                        if (e.target.closest('.task-checkbox-styled, .drag-handle, .task-actions, .btn-icon, .task-edit-form, .contact-badge-clickable')) return;
                        if (editingTask === task.id) return;
                        setExpandedTask(expandedTask === task.id ? null : task.id);
                      }}>
                        <span className="drag-handle" {...dragListeners}>⠿</span>
                        <div
                          className="task-checkbox-styled"
                          onClick={() => (!task.completed || user?.role === 'admin') && toggleTask(task)}
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
                                onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value, reminder: e.target.value ? editForm.reminder : '' })}
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
                            {editForm.dueDate && (
                              <div className="task-edit-row">
                                <select
                                  value={editForm.reminder || ''}
                                  onChange={(e) => setEditForm({ ...editForm, reminder: e.target.value })}
                                  className="form-input"
                                  title="Pripomienka pred termínom"
                                >
                                  <option value="">🔔 Bez pripomienky</option>
                                  <option value="0">🔔 V deň termínu</option>
                                  <option value="1">🔔 1 deň pred</option>
                                  <option value="3">🔔 3 dni pred</option>
                                  <option value="7">🔔 7 dní pred</option>
                                  <option value="14">🔔 14 dní pred</option>
                                </select>
                              </div>
                            )}
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
                                <span className={`due-date ${getDueDateClass(task.dueDate, task.completed)}`}>
                                  {getDueDateClass(task.dueDate, task.completed) === 'overdue' ? '⚠️' : '📅'} {formatDate(task.dueDate)}
                                  {task.reminder != null && <span title={`Pripomienka ${task.reminder === 0 ? 'v deň termínu' : task.reminder + ' dní pred'}`}> 🔔</span>}
                                </span>
                              )}
                              {(task.contactName || task.contactNames?.length > 0) && (
                                <span
                                  className="contact-badge contact-badge-clickable"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const cId = task.contactIds?.[0] || task.contactId;
                                    if (cId) navigate(`/crm?expandContact=${cId}&_t=${Date.now()}`);
                                  }}
                                  title="Otvoriť kontakt"
                                >
                                  🏷️ {task.contactNames?.length > 0 ? task.contactNames.join(', ') : task.contactName}
                                </span>
                              )}
                              {task.subtasks?.length > 0 && (
                                <span className="subtask-count">
                                  ✓ {countSubtasksRecursive(task.subtasks).completed}/{countSubtasksRecursive(task.subtasks).total}
                                </span>
                              )}
                              {task.files?.length > 0 && (
                                <span className="subtask-count" title={`${task.files.length} príloha`}>
                                  📎 {task.files.length}
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

                          {/* Task file attachments */}
                          <div className="task-files-section">
                            <div className="task-files-header">
                              <span>📎 Prílohy</span>
                              <button
                                className="btn btn-secondary btn-sm btn-attach"
                                onClick={() => triggerFileUpload(task.id || task._id)}
                                disabled={uploadingFile === (task.id || task._id)}
                              >
                                {uploadingFile === (task.id || task._id) ? '⏳' : '+'} Pridať
                              </button>
                            </div>
                            {task.files?.length > 0 && (
                              <div className="task-files-list">
                                {task.files.map(file => (
                                  <div key={file.id} className="task-file-item">
                                    <span className="task-file-icon">{getFileIcon(file.mimetype)}</span>
                                    <span className="task-file-name" title={file.originalName}>{file.originalName}</span>
                                    <span className="task-file-size">{formatFileSize(file.size)}</span>
                                    <button className="btn-icon-sm" onClick={() => handleFileDownload(task.id || task._id, file.id, file.originalName)} title="Stiahnuť">⬇️</button>
                                    <button className="btn-icon-sm btn-delete" onClick={() => handleFileDelete(task.id || task._id, file.id)} title="Vymazať">×</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="subtasks">
                            <div className="subtasks-header">Úlohy</div>

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
                                    placeholder="Pridať úlohu..."
                                    className="form-input form-input-sm"
                                  />
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${showSubtaskDateInput[task.id] ? 'active' : ''}`}
                                    onClick={() => setShowSubtaskDateInput(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                                    title="Termín"
                                  >
                                    📅
                                  </button>
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
                                  <button type="submit" className="btn btn-primary btn-sm add-subtask-submit" title="Uložiť úlohu (Enter)"><span className="desktop-only">+</span><span className="ios-only">Uložiť</span></button>
                                </form>
                                {showSubtaskDateInput[task.id] && (
                                  <input
                                    type="date"
                                    value={subtaskDueDates[task.id] || ''}
                                    onChange={(e) => setSubtaskDueDates(prev => ({ ...prev, [task.id]: e.target.value }))}
                                    className="form-input form-input-sm"
                                    autoFocus
                                  />
                                )}
                                {showSubtaskNotesInput[task.id] && (
                                  <textarea
                                    value={subtaskNotes[task.id] || ''}
                                    onChange={(e) => setSubtaskNotes(prev => ({ ...prev, [task.id]: e.target.value }))}
                                    placeholder="Poznámka k úlohe..."
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
                      )}
                    </SortableTaskItem>
                  )})}
                </div>
                  </SortableContext>
                </DndContext>
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
              <h3>Duplikovať projekt</h3>
              <button className="modal-close" onClick={closeDuplicateModal}>×</button>
            </div>
            <div className="modal-body">
              <p className="duplicate-info">
                Duplikuje sa projekt: <strong>{duplicatingTask.title}</strong>
                {duplicatingTask.subtasks?.length > 0 && (
                  <span className="subtask-info"> (vrátane {duplicatingTask.subtasks.length} úloh)</span>
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

      {/* Hidden file inputs */}
      <input type="file" ref={taskFileInputRef} style={{ display: 'none' }} onChange={(e) => onFileSelected(e, false)} />
      <input type="file" ref={subtaskFileInputRef} style={{ display: 'none' }} onChange={(e) => onFileSelected(e, true)} />

      {/* Help Guide */}
      <HelpGuide
        section="tasks"
        title="Správa projektov"
        tips={tasksHelpTips}
      />
    </div>
  );
}

export default Tasks;
