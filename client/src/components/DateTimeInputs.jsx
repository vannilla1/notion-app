import { useRef } from 'react';

/**
 * Reusable wrapper okolo natívneho `<input type="date">` + `<input type="time">`
 * s týmito vylepšeniami:
 *
 * 1. `showPicker()` na klik — obchádza prípady, kedy iOS / niektoré CSS layoutov
 *    blokujú default tap-to-open na natívnom inpute. Funguje vo všetkých
 *    moderných prehliadačoch (fallback: native click ak metóda chýba).
 * 2. Tlačidlo "×" pre rýchly reset — keď user chce zmeniť termín alebo úplne
 *    zrušiť čas/dátum bez potreby otvárať picker a manuálne mazať.
 * 3. Po zmene hodiny sa native picker `<input type="time">` sám preskočí na
 *    minúty. Plus `step="60"` skryje sekundové pole.
 *
 * Props:
 *   value: string ("YYYY-MM-DD" alebo "HH:MM")
 *   onChange: (newValue: string) => void
 *   type: 'date' | 'time'
 *   disabled?: boolean
 *   placeholder?: string
 *   className?: string
 *   style?: React.CSSProperties
 *   title?: string
 *   ariaLabel?: string
 */
export function DateInput({ value, onChange, disabled, className = '', style, title, ariaLabel, autoFocus }) {
  return (
    <DateTimeInput
      type="date"
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
      style={style}
      title={title}
      ariaLabel={ariaLabel}
      autoFocus={autoFocus}
    />
  );
}

export function TimeInput({ value, onChange, disabled, className = '', style, title, ariaLabel }) {
  return (
    <DateTimeInput
      type="time"
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
      style={style}
      title={title}
      ariaLabel={ariaLabel}
    />
  );
}

function DateTimeInput({ type, value, onChange, disabled, className, style, title, ariaLabel, autoFocus }) {
  const inputRef = useRef(null);

  const openPicker = () => {
    const el = inputRef.current;
    if (!el || el.disabled) return;
    // showPicker() je modern API ktoré spoľahlivo otvorí natívny picker aj
    // keď default tap-to-open zlyhal kvôli prekrytým eventom alebo iOS quirk-u.
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); } catch { /* user-interaction context not available */ }
    } else {
      el.focus();
      el.click();
    }
  };

  const clear = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onChange('');
  };

  const hasValue = !!value;

  return (
    <div className={`dt-input-wrapper ${disabled ? 'dt-disabled' : ''}`} style={style}>
      <input
        ref={inputRef}
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onClick={openPicker}
        onFocus={openPicker}
        disabled={disabled}
        className={`form-input dt-input ${className}`}
        title={title}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        step={type === 'time' ? 60 : undefined}
      />
      {hasValue && !disabled && (
        <button
          type="button"
          className="dt-clear-btn"
          onClick={clear}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          title={type === 'date' ? 'Vymazať dátum' : 'Vymazať čas'}
          aria-label={type === 'date' ? 'Vymazať dátum' : 'Vymazať čas'}
        >
          ×
        </button>
      )}
    </div>
  );
}
