import { useState } from 'react';
import api from '../api/api';

function TaskList({ contactId, tasks = [], onContactRefresh }) {
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [expandedTask, setExpandedTask] = useState(null);
  const [subtaskInputs, setSubtaskInputs] = useState({});
  const [editingTask, setEditingTask] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editingSubtask, setEditingSubtask] = useState(null);
  const [editSubtaskTitle, setEditSubtaskTitle] = useState('');

  // Helper to refresh contact data after changes
  const refreshContact = async () => {
    if (onContactRefresh) {
      await onContactRefresh();
    }
  };

  const addTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    try {
      await api.post(`/api/contacts/${contactId}/tasks`, {
        title: newTaskTitle,
        priority: 'medium'
      });
      setNewTaskTitle('');
      await refreshContact();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní úlohy');
    }
  };

  const toggleTask = async (taskId, completed) => {
    try {
      await api.put(`/api/contacts/${contactId}/tasks/${taskId}`, {
        completed: !completed
      });
      await refreshContact();
    } catch (error) {
      console.error('Failed to toggle task:', error);
    }
  };

  const deleteTask = async (taskId) => {
    if (!window.confirm('Vymazať túto úlohu?')) return;
    try {
      await api.delete(`/api/contacts/${contactId}/tasks/${taskId}`);
      await refreshContact();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const addSubtask = async (e, taskId) => {
    e.preventDefault();
    const subtaskTitle = subtaskInputs[taskId] || '';
    if (!subtaskTitle.trim()) return;

    try {
      await api.post(`/api/contacts/${contactId}/tasks/${taskId}/subtasks`, {
        title: subtaskTitle
      });
      setSubtaskInputs(prev => ({ ...prev, [taskId]: '' }));
      await refreshContact();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní podúlohy');
    }
  };

  const toggleSubtask = async (taskId, subtaskId, completed) => {
    try {
      await api.put(`/api/contacts/${contactId}/tasks/${taskId}/subtasks/${subtaskId}`, {
        completed: !completed
      });
      await refreshContact();
    } catch (error) {
      console.error('Failed to toggle subtask:', error);
    }
  };

  const deleteSubtask = async (taskId, subtaskId) => {
    try {
      await api.delete(`/api/contacts/${contactId}/tasks/${taskId}/subtasks/${subtaskId}`);
      await refreshContact();
    } catch (error) {
      console.error('Failed to delete subtask:', error);
    }
  };

  const startEditSubtask = (taskId, subtask) => {
    setEditingSubtask({ taskId, subtaskId: subtask.id });
    setEditSubtaskTitle(subtask.title);
  };

  const saveSubtask = async (taskId, subtaskId) => {
    if (!editSubtaskTitle.trim()) return;
    try {
      await api.put(`/api/contacts/${contactId}/tasks/${taskId}/subtasks/${subtaskId}`, {
        title: editSubtaskTitle
      });
      setEditingSubtask(null);
      setEditSubtaskTitle('');
      await refreshContact();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní podúlohy');
    }
  };

  const cancelEditSubtask = () => {
    setEditingSubtask(null);
    setEditSubtaskTitle('');
  };

  const startEditTask = (task) => {
    setEditingTask(task.id);
    setEditForm({
      title: task.title,
      description: task.description || '',
      dueDate: task.dueDate || '',
      priority: task.priority || 'medium'
    });
  };

  const saveTask = async (taskId) => {
    try {
      await api.put(`/api/contacts/${contactId}/tasks/${taskId}`, editForm);
      setEditingTask(null);
      await refreshContact();
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní úlohy');
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

  const completedCount = tasks.filter(t => t.completed).length;

  return (
    <div className="task-list">
      <div className="task-header">
        <h3>Úlohy ({completedCount}/{tasks.length})</h3>
      </div>

      <form onSubmit={addTask} className="add-task-form">
        <input
          type="text"
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          placeholder="Pridať novú úlohu..."
          className="form-input"
        />
        <button type="submit" className="btn btn-primary">+</button>
      </form>

      <div className="tasks">
        {tasks.length === 0 ? (
          <div className="no-tasks">Žiadne úlohy</div>
        ) : (
          tasks.map(task => (
            <div key={task.id} className={`task-item ${task.completed ? 'completed' : ''}`}>
              <div className="task-main">
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => toggleTask(task.id, task.completed)}
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
                      {task.subtasks?.length > 0 && (
                        <span className="subtask-count">
                          ✓ {task.subtasks.filter(s => s.completed).length}/{task.subtasks.length}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {editingTask !== task.id && (
                  <div className="task-actions">
                    <button onClick={() => startEditTask(task)} className="btn-icon" title="Upraviť">✏️</button>
                    <button onClick={() => deleteTask(task.id)} className="btn-icon" title="Vymazať">🗑️</button>
                  </div>
                )}
              </div>

              {expandedTask === task.id && editingTask !== task.id && (
                <div className="task-expanded">
                  {task.description && (
                    <div className="task-description">{task.description}</div>
                  )}

                  <div className="subtasks">
                    <div className="subtasks-header">Podúlohy</div>

                    {task.subtasks?.map(subtask => (
                      <div key={subtask.id} className={`subtask-item ${subtask.completed ? 'completed' : ''}`}>
                        <input
                          type="checkbox"
                          checked={subtask.completed}
                          onChange={() => toggleSubtask(task.id, subtask.id, subtask.completed)}
                          className="task-checkbox"
                        />
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
                                  saveSubtask(task.id, subtask.id);
                                } else if (e.key === 'Escape') {
                                  cancelEditSubtask();
                                }
                              }}
                            />
                            <button
                              onClick={() => saveSubtask(task.id, subtask.id)}
                              className="btn-icon-sm btn-save"
                              title="Uložiť"
                            >
                              ✓
                            </button>
                            <button
                              onClick={cancelEditSubtask}
                              className="btn-icon-sm btn-cancel"
                              title="Zrušiť"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <>
                            <span
                              className="subtask-title"
                              onDoubleClick={() => startEditSubtask(task.id, subtask)}
                              title="Dvojklik pre úpravu"
                            >
                              {subtask.title}
                            </span>
                            <div className="subtask-actions">
                              <button
                                onClick={() => startEditSubtask(task.id, subtask)}
                                className="btn-icon-sm"
                                title="Upraviť"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={() => deleteSubtask(task.id, subtask.id)}
                                className="btn-icon-sm"
                                title="Vymazať"
                              >
                                ×
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}

                    <form onSubmit={(e) => addSubtask(e, task.id)} className="add-subtask-form">
                      <input
                        type="text"
                        value={subtaskInputs[task.id] || ''}
                        onChange={(e) => setSubtaskInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                        placeholder="Pridať podúlohu..."
                        className="form-input form-input-sm"
                      />
                      <button type="submit" className="btn btn-secondary btn-sm">+</button>
                    </form>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default TaskList;
