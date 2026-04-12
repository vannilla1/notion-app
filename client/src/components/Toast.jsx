import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import PropTypes from 'prop-types';
import './Toast.css';

const ToastContext = createContext(null);

export const TOAST_TYPES = {
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = TOAST_TYPES.INFO, duration = 5000) => {
    const id = Date.now() + Math.random();
    const toast = { id, message, type, duration };

    setToasts(prev => [...prev, toast]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }

    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showSuccess = useCallback((message, duration) => {
    return addToast(message, TOAST_TYPES.SUCCESS, duration);
  }, [addToast]);

  const showError = useCallback((message, duration = 7000) => {
    return addToast(message, TOAST_TYPES.ERROR, duration);
  }, [addToast]);

  const showWarning = useCallback((message, duration) => {
    return addToast(message, TOAST_TYPES.WARNING, duration);
  }, [addToast]);

  const showInfo = useCallback((message, duration) => {
    return addToast(message, TOAST_TYPES.INFO, duration);
  }, [addToast]);

  const clearAll = useCallback(() => {
    setToasts([]);
  }, []);

  const value = {
    toasts,
    addToast,
    removeToast,
    showSuccess,
    showError,
    showWarning,
    showInfo,
    clearAll
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
};

ToastProvider.propTypes = {
  children: PropTypes.node.isRequired
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

const ToastContainer = ({ toasts, onRemove }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
};

ToastContainer.propTypes = {
  toasts: PropTypes.array.isRequired,
  onRemove: PropTypes.func.isRequired
};

const ToastItem = ({ toast, onRemove }) => {
  const [isExiting, setIsExiting] = useState(false);

  const handleRemove = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onRemove(toast.id);
    }, 300); // Match animation duration
  }, [toast.id, onRemove]);

  const getIcon = () => {
    switch (toast.type) {
      case TOAST_TYPES.SUCCESS:
        return '✓';
      case TOAST_TYPES.ERROR:
        return '✕';
      case TOAST_TYPES.WARNING:
        return '⚠';
      case TOAST_TYPES.INFO:
      default:
        return 'ℹ';
    }
  };

  return (
    <div className={`toast toast-${toast.type} ${isExiting ? 'toast-exit' : ''}`}>
      <span className="toast-icon">{getIcon()}</span>
      <span className="toast-message">{toast.message}</span>
      <button
        className="toast-close"
        onClick={handleRemove}
        aria-label="Zavrieť"
      >
        ×
      </button>
    </div>
  );
};

ToastItem.propTypes = {
  toast: PropTypes.shape({
    id: PropTypes.number.isRequired,
    message: PropTypes.string.isRequired,
    type: PropTypes.string.isRequired
  }).isRequired,
  onRemove: PropTypes.func.isRequired
};

export default ToastProvider;
