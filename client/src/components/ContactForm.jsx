import { useState } from 'react';

function ContactForm({ onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    website: '',
    notes: '',
    status: 'new'
  });
  const [errors, setErrors] = useState({});

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

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Final validation
    const newErrors = {};
    if (!formData.name.trim()) {
      newErrors.name = 'Meno je povinné';
    }
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
      await onSubmit(formData);
    } catch (error) {
      alert(error.response?.data?.message || 'Chyba pri vytváraní kontaktu');
    }
  };

  return (
    <div className="contact-form-container">
      <h2>Nový kontakt</h2>
      <form onSubmit={handleSubmit}>
        <div className="contact-form-grid">
          <div className="form-group">
            <label>Meno *</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className={`form-input ${errors.name ? 'form-input-error' : ''}`}
              placeholder="Meno a priezvisko"
            />
            {errors.name && <span className="form-error">{errors.name}</span>}
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              type="text"
              name="email"
              value={formData.email}
              onChange={handleChange}
              className={`form-input ${errors.email ? 'form-input-error' : ''}`}
              placeholder="meno@domena.sk"
            />
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>
          <div className="form-group">
            <label>Telefón</label>
            <input
              type="text"
              name="phone"
              value={formData.phone}
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
              value={formData.company}
              onChange={handleChange}
              className="form-input"
              placeholder="Názov firmy"
            />
          </div>
          <div className="form-group">
            <label>Webstránka</label>
            <input
              type="url"
              name="website"
              value={formData.website}
              onChange={handleChange}
              className="form-input"
              placeholder="https://www.example.sk"
            />
          </div>
          <div className="form-group">
            <label>Status</label>
            <select
              name="status"
              value={formData.status}
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
              value={formData.notes}
              onChange={handleChange}
              className="form-input"
              rows={4}
              placeholder="Poznámky ku kontaktu..."
            />
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">Vytvoriť</button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Zrušiť</button>
        </div>
      </form>
    </div>
  );
}

export default ContactForm;
