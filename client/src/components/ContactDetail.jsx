import { useState, useRef, useEffect } from 'react';
import TaskList from './TaskList';
import { API_BASE_URL } from '../api/api';

function ContactDetail({ contact, onUpdate, onDelete, onUploadFile, onDeleteFile, onBack, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState(contact);
  const [errors, setErrors] = useState({});
  const fileInputRef = useRef(null);

  useEffect(() => {
    setFormData(contact);
  }, [contact]);

  const validateEmail = (email) => {
    if (!email) return true;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const validatePhone = (phone) => {
    if (!phone) return true;
    const phoneRegex = /^[+]?[0-9\s-]+$/;
    return phoneRegex.test(phone);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });

    // Real-time validation
    if (name === 'email') {
      if (value && !validateEmail(value)) {
        setErrors({ ...errors, email: 'Neplatný formát emailu (napr. meno@domena.sk)' });
      } else {
        const { email, ...rest } = errors;
        setErrors(rest);
      }
    }

    if (name === 'phone') {
      if (value && !validatePhone(value)) {
        setErrors({ ...errors, phone: 'Telefón môže obsahovať len čísla, medzery, pomlčky a +' });
      } else {
        const { phone, ...rest } = errors;
        setErrors(rest);
      }
    }
  };

  const handleSave = async () => {
    // Final validation
    const newErrors = {};
    if (formData.email && !validateEmail(formData.email)) {
      newErrors.email = 'Neplatný formát emailu';
    }
    if (formData.phone && !validatePhone(formData.phone)) {
      newErrors.phone = 'Telefón môže obsahovať len čísla, medzery, pomlčky a +';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    try {
      await onUpdate(contact.id, formData);
      setEditing(false);
      setErrors({});
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri ukladaní');
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      onUploadFile(contact.id, file);
      e.target.value = '';
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('sk-SK', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getFileIcon = (mimetype) => {
    if (mimetype?.startsWith('image/')) return '🖼️';
    if (mimetype?.includes('pdf')) return '📕';
    if (mimetype?.includes('word') || mimetype?.includes('document')) return '📘';
    if (mimetype?.includes('excel') || mimetype?.includes('sheet')) return '📗';
    return '📄';
  };

  const isImage = (mimetype) => mimetype?.startsWith('image/');

  return (
    <div className="contact-detail">
      <div className="contact-detail-header">
        <div className="contact-header-left">
          <button className="btn-back" onClick={onBack} title="Späť">
            ← Späť
          </button>
          <h2>{contact.name || 'Bez mena'}</h2>
        </div>
        <div className="contact-detail-actions">
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={handleSave}>Uložiť</button>
              <button className="btn btn-secondary" onClick={() => {
                setFormData(contact);
                setEditing(false);
                setErrors({});
              }}>Zrušiť</button>
            </>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={() => setEditing(true)}>Upraviť</button>
              <button className="btn btn-danger" onClick={() => onDelete(contact.id)}>Vymazať</button>
            </>
          )}
        </div>
      </div>

      <div className="contact-detail-content">
        <div className="contact-section">
          <h3>Základné údaje</h3>
          {editing ? (
            <div className="contact-form-grid">
              <div className="form-group">
                <label>Meno</label>
                <input
                  type="text"
                  name="name"
                  value={formData.name || ''}
                  onChange={handleChange}
                  className="form-input"
                />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  name="email"
                  value={formData.email || ''}
                  onChange={handleChange}
                  className={`form-input ${errors.email ? 'form-input-error' : ''}`}
                  placeholder="meno@domena.sk"
                />
                {errors.email && <span className="form-error">{errors.email}</span>}
              </div>
              <div className="form-group">
                <label>Telefón</label>
                <input
                  type="tel"
                  name="phone"
                  value={formData.phone || ''}
                  onChange={handleChange}
                  className={`form-input ${errors.phone ? 'form-input-error' : ''}`}
                  placeholder="+421 xxx xxx xxx"
                />
                {errors.phone && <span className="form-error">{errors.phone}</span>}
              </div>
              <div className="form-group">
                <label>Firma</label>
                <input
                  type="text"
                  name="company"
                  value={formData.company || ''}
                  onChange={handleChange}
                  className="form-input"
                />
              </div>
              <div className="form-group">
                <label>Webstránka</label>
                <input
                  type="url"
                  name="website"
                  value={formData.website || ''}
                  onChange={handleChange}
                  className="form-input"
                  placeholder="https://www.example.sk"
                />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select
                  name="status"
                  value={formData.status || 'new'}
                  onChange={handleChange}
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
                  name="notes"
                  value={formData.notes || ''}
                  onChange={handleChange}
                  className="form-input"
                  rows={4}
                />
              </div>
            </div>
          ) : (
            <div className="contact-info-grid">
              <div className="info-item">
                <span className="info-label">Email</span>
                <span className="info-value">{contact.email || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Telefón</span>
                <span className="info-value">{contact.phone || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Firma</span>
                <span className="info-value">{contact.company || '-'}</span>
              </div>
              <div className="info-item">
                <span className="info-label">Webstránka</span>
                <span className="info-value">
                  {contact.website ? (
                    <a href={contact.website} target="_blank" rel="noopener noreferrer" className="website-link">
                      {contact.website}
                    </a>
                  ) : '-'}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Status</span>
                <select
                  value={contact.status || 'new'}
                  onChange={(e) => onUpdate(contact.id, { status: e.target.value })}
                  className="status-select"
                >
                  <option value="new">Nový</option>
                  <option value="active">Aktívny</option>
                  <option value="completed">Dokončený</option>
                  <option value="cancelled">Zrušený</option>
                </select>
              </div>
              <div className="info-item full-width">
                <span className="info-label">Poznámky</span>
                <span className="info-value notes">{contact.notes || '-'}</span>
              </div>
            </div>
          )}
        </div>

        {/* Tasks Section */}
        <div className="contact-section">
          <TaskList
            contactId={contact.id}
            tasks={contact.tasks || []}
            onContactRefresh={onRefresh}
          />
        </div>

        <div className="contact-section">
          <div className="section-header">
            <h3>Súbory ({contact.files?.length || 0})</h3>
            <button
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              + Pridať súbor
            </button>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
            />
          </div>

          {contact.files?.length > 0 ? (
            <div className="files-grid">
              {contact.files.map(file => (
                <div key={file.id} className="file-item">
                  {isImage(file.mimetype) ? (
                    <div className="file-preview">
                      <img
                        src={`${API_BASE_URL}/uploads/${file.filename}`}
                        alt={file.originalName}
                      />
                    </div>
                  ) : (
                    <div className="file-icon">{getFileIcon(file.mimetype)}</div>
                  )}
                  <div className="file-info">
                    <div className="file-name" title={file.originalName}>
                      {file.originalName}
                    </div>
                    <div className="file-meta">
                      {formatFileSize(file.size)} • {formatDate(file.uploadedAt)}
                    </div>
                  </div>
                  <div className="file-actions">
                    <a
                      href={`${API_BASE_URL}/uploads/${file.filename}`}
                      download={file.originalName}
                      className="btn-icon"
                      title="Stiahnuť"
                    >
                      ⬇️
                    </a>
                    <button
                      className="btn-icon"
                      onClick={() => onDeleteFile(contact.id, file.id)}
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

        <div className="contact-meta">
          <span>Vytvoril: {contact.createdBy}</span>
          <span>Vytvorené: {formatDate(contact.createdAt)}</span>
          <span>Upravené: {formatDate(contact.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

export default ContactDetail;
