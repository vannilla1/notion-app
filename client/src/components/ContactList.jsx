function ContactList({ contacts, selectedId, onSelect, loading }) {
  const getStatusColor = (status) => {
    switch (status) {
      case 'new': return '#3B82F6';
      case 'active': return '#10B981';
      case 'completed': return '#6B7280';
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

  if (loading) {
    return <div className="contact-list-loading">Načítavam...</div>;
  }

  if (contacts.length === 0) {
    return (
      <div className="contact-list-empty">
        Žiadne kontakty
      </div>
    );
  }

  return (
    <div className="contact-list">
      {contacts.map(contact => (
        <div
          key={contact.id}
          className={`contact-item ${selectedId === contact.id ? 'active' : ''}`}
          onClick={() => onSelect(contact)}
        >
          <div className="contact-item-avatar">
            {contact.name?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="contact-item-info">
            <div className="contact-item-name">{contact.name || 'Bez mena'}</div>
            <div className="contact-item-company">{contact.company || 'Bez firmy'}</div>
          </div>
          <div
            className="contact-item-status"
            style={{ backgroundColor: getStatusColor(contact.status) }}
            title={getStatusLabel(contact.status)}
          />
        </div>
      ))}
    </div>
  );
}

export default ContactList;
