export const formatDate = (dateString, options = {}) => {
  if (!dateString) return '-';

  const defaultOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...options
  };

  try {
    return new Date(dateString).toLocaleDateString('sk-SK', defaultOptions);
  } catch {
    return '-';
  }
};

export const formatDateTime = (dateString) => {
  if (!dateString) return '-';

  try {
    return new Date(dateString).toLocaleString('sk-SK', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '-';
  }
};

export const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${units[i]}`;
};

export const formatRelativeTime = (dateString) => {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'práve teraz';
  if (diffMins < 60) return `pred ${diffMins} min`;
  if (diffHours < 24) return `pred ${diffHours} hod`;
  if (diffDays < 7) return `pred ${diffDays} dňami`;

  return formatDate(dateString);
};

export const truncateText = (text, maxLength = 100) => {
  if (!text || text.length <= maxLength) return text || '';
  return `${text.substring(0, maxLength)}...`;
};

export const formatNumber = (num) => {
  if (num === null || num === undefined) return '0';
  return num.toLocaleString('sk-SK');
};
