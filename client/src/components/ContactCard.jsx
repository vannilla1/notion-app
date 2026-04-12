import { memo } from 'react';
import PropTypes from 'prop-types';
import { getStatusColor, getStatusLabel } from '../utils/constants';

const ContactCard = memo(function ContactCard({
  contact,
  isExpanded,
  isHighlighted,
  isEditing,
  editForm,
  onToggleExpand,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onEditFormChange,
  getContactTasks,
  children // For expanded content (tasks, files, etc.)
}) {
  const handleToggleExpand = () => {
    if (!isEditing) {
      onToggleExpand(contact.id);
    }
  };

  return (
    <div
      data-contact-id={contact.id}
      className={`contact-card ${isExpanded ? 'expanded' : ''} ${isHighlighted ? 'highlighted' : ''}`}
    >
      <div className="contact-main">
        <div
          className="contact-avatar"
          style={{ backgroundColor: getStatusColor(contact.status) }}
        >
          {contact.name.charAt(0).toUpperCase()}
        </div>

        {isEditing ? (
          <ContactEditForm
            editForm={editForm}
            onEditFormChange={onEditFormChange}
            onSave={() => onSaveEdit(contact.id)}
            onCancel={onCancelEdit}
          />
        ) : (
          <ContactContent
            contact={contact}
            onClick={handleToggleExpand}
            getContactTasks={getContactTasks}
          />
        )}

        {!isEditing && (
          <div className="contact-actions">
            <button
              onClick={() => onStartEdit(contact)}
              className="btn-icon"
              title="Upraviť"
            >
              ✏️
            </button>
            <button
              onClick={() => onDelete(contact)}
              className="btn-icon"
              title="Vymazať"
            >
              🗑️
            </button>
          </div>
        )}
      </div>

      {isExpanded && !isEditing && children}
    </div>
  );
});

const ContactContent = memo(function ContactContent({ contact, onClick, getContactTasks }) {
  const allTasks = getContactTasks ? getContactTasks(contact) : [];
  const completedTasks = allTasks.filter(t => t.completed).length;

  return (
    <div className="contact-content" onClick={onClick}>
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
        {allTasks.length > 0 && (
          <span className="tasks-count">
            ✓ {completedTasks}/{allTasks.length}
          </span>
        )}
      </div>
    </div>
  );
});

const ContactEditForm = memo(function ContactEditForm({
  editForm,
  onEditFormChange,
  onSave,
  onCancel
}) {
  const handleChange = (field) => (e) => {
    onEditFormChange({ ...editForm, [field]: e.target.value });
  };

  return (
    <div className="contact-edit-form">
      <input
        type="text"
        value={editForm.name || ''}
        onChange={handleChange('name')}
        className="form-input"
        placeholder="Meno"
      />
      <div className="contact-edit-row">
        <input
          type="email"
          value={editForm.email || ''}
          onChange={handleChange('email')}
          className="form-input"
          placeholder="Email"
        />
        <input
          type="tel"
          value={editForm.phone || ''}
          onChange={handleChange('phone')}
          className="form-input"
          placeholder="Telefón"
        />
      </div>
      <div className="contact-edit-row">
        <input
          type="text"
          value={editForm.company || ''}
          onChange={handleChange('company')}
          className="form-input"
          placeholder="Firma"
        />
        <select
          value={editForm.status || 'new'}
          onChange={handleChange('status')}
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
        value={editForm.website || ''}
        onChange={handleChange('website')}
        className="form-input"
        placeholder="www.example.sk"
      />
      <textarea
        value={editForm.notes || ''}
        onChange={handleChange('notes')}
        className="form-input"
        placeholder="Poznámky"
        rows={2}
      />
      <div className="contact-edit-actions">
        <button onClick={onSave} className="btn btn-primary btn-sm">
          Uložiť
        </button>
        <button onClick={onCancel} className="btn btn-secondary btn-sm">
          Zrušiť
        </button>
      </div>
    </div>
  );
});

export const ContactDetails = memo(function ContactDetails({ contact }) {
  return (
    <div className="contact-details">
      {contact.phone && (
        <div className="detail-item">
          <span className="detail-label">📞 Telefón:</span>
          <a href={`tel:${contact.phone}`} className="detail-value">
            {contact.phone}
          </a>
        </div>
      )}
      {contact.email && (
        <div className="detail-item">
          <span className="detail-label">✉️ Email:</span>
          <a href={`mailto:${contact.email}`} className="detail-value">
            {contact.email}
          </a>
        </div>
      )}
      {contact.website && (
        <div className="detail-item">
          <span className="detail-label">🌐 Web:</span>
          <a
            href={contact.website.startsWith('http') ? contact.website : `https://${contact.website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="detail-value website-link"
          >
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
  );
});

ContactCard.propTypes = {
  contact: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    email: PropTypes.string,
    phone: PropTypes.string,
    company: PropTypes.string,
    website: PropTypes.string,
    notes: PropTypes.string,
    status: PropTypes.string
  }).isRequired,
  isExpanded: PropTypes.bool,
  isHighlighted: PropTypes.bool,
  isEditing: PropTypes.bool,
  editForm: PropTypes.object,
  onToggleExpand: PropTypes.func.isRequired,
  onStartEdit: PropTypes.func.isRequired,
  onSaveEdit: PropTypes.func.isRequired,
  onCancelEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onEditFormChange: PropTypes.func.isRequired,
  getContactTasks: PropTypes.func,
  children: PropTypes.node
};

ContactCard.defaultProps = {
  isExpanded: false,
  isHighlighted: false,
  isEditing: false,
  editForm: {}
};

ContactContent.propTypes = {
  contact: PropTypes.object.isRequired,
  onClick: PropTypes.func.isRequired,
  getContactTasks: PropTypes.func
};

ContactEditForm.propTypes = {
  editForm: PropTypes.object.isRequired,
  onEditFormChange: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired
};

ContactDetails.propTypes = {
  contact: PropTypes.object.isRequired
};

export default ContactCard;
