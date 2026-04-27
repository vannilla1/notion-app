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

  // Pri click/touch sa pokúsime force-open natívny picker. Niektoré
  // browser/input-type kombinácie (najmä iOS Safari + type="time") občas
  // potrebujú aktívny user-gesture flow ktorý showPicker() vyžaduje, inak
  // tichý "no-op". Preto fallbackujeme na focus(), čo iOS spoľahlivo otvorí.
  const openPicker = () => {
    const el = inputRef.current;
    if (!el || el.disabled) return;

    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // showPicker odmietnuté (mimo user-gesture kontextu alebo browser
        // nepodporuje pre tento input-type) — pokračuj s focus fallbackom.
      }
    }
    // Native fallback: focus rozhne picker na iOS, na desktope user uvidí
    // kurzor v inpute a po stlačení šípky / klávesnice picker otvorí.
    el.focus();
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
        // onMouseDown sa spustí PRED click + focus → guaranteed user-gesture
        // context pre showPicker(). Plus pokrýva touch (iOS posiela
        // syntetický mouseDown). onFocus už voláme len pri kbd-tab cez form
        // a len ak hodnota chýba (vtedy chceme rovnaký pickerovo-otvárací UX).
        onMouseDown={openPicker}
        onTouchStart={openPicker}
        onFocus={!hasValue ? openPicker : undefined}
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
