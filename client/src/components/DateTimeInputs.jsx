import { useRef, useEffect } from 'react';

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

/**
 * TimeInput — split-segment picker pre hodiny a minúty.
 *
 * Pôvodne sme používali natívny <input type="time">, ale jeho interný
 * segment-based focus management ignoruje externé `setSelectionRange()`,
 * takže auto-skok z hodín na minúty po napísaní 2 číslic nefungoval na
 * macOS Safari (a iných prehliadačoch). Tento komponent rieši problém
 * dvoma samostatnými text-inputmi spojenými cez "HH:MM" string.
 *
 * - Po napísaní 2 číslic v hodinách → focus skočí na minúty
 * - Backspace v prázdnych minútach → focus späť na hodiny
 * - Klik na ikonku × vymaže obe polia
 * - Hodnoty sa clamp-ujú: HH 00-23, MM 00-59
 */
export function TimeInput({ value, onChange, disabled, className = '', style, title, ariaLabel }) {
  const hoursRef = useRef(null);
  const minutesRef = useRef(null);

  // Rozparsujeme HH:MM, alebo prázdne hodnoty.
  const [hh = '', mm = ''] = (value || '').split(':');

  const updateHours = (raw) => {
    // Iba číslice, max 2.
    let v = String(raw || '').replace(/\D/g, '').slice(0, 2);
    if (v && parseInt(v, 10) > 23) v = '23';
    const newVal = v ? `${v.padStart(2, '0')}:${mm || '00'}` : '';
    onChange(newVal);
    // Po napísaní 2 číslic auto-skok na minúty.
    if (v.length === 2) {
      requestAnimationFrame(() => {
        const el = minutesRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    }
  };

  const updateMinutes = (raw) => {
    let v = String(raw || '').replace(/\D/g, '').slice(0, 2);
    if (v && parseInt(v, 10) > 59) v = '59';
    if (!hh && !v) {
      onChange('');
    } else {
      onChange(`${(hh || '00').padStart(2, '0')}:${v.padStart(2, '0') || '00'}`);
    }
  };

  const handleMinutesKeyDown = (e) => {
    // Backspace v prázdnych minútach → späť na hodiny (intuitívne pre rýchle úpravy)
    if (e.key === 'Backspace' && !mm) {
      e.preventDefault();
      const el = hoursRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  };

  const clear = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onChange('');
    requestAnimationFrame(() => hoursRef.current?.focus());
  };

  const hasValue = !!(hh || mm);

  return (
    <div className={`dt-input-wrapper time-split ${disabled ? 'dt-disabled' : ''}`} style={style} title={title}>
      <input
        ref={hoursRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={hh}
        onChange={(e) => updateHours(e.target.value)}
        onFocus={(e) => e.target.select()}
        disabled={disabled}
        placeholder="HH"
        className={`form-input dt-input dt-time-segment ${className}`}
        aria-label={ariaLabel ? `${ariaLabel} — hodiny` : 'Hodiny'}
      />
      <span className="dt-time-colon" aria-hidden="true">:</span>
      <input
        ref={minutesRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={mm}
        onChange={(e) => updateMinutes(e.target.value)}
        onKeyDown={handleMinutesKeyDown}
        onFocus={(e) => e.target.select()}
        disabled={disabled}
        placeholder="MM"
        className={`form-input dt-input dt-time-segment ${className}`}
        aria-label={ariaLabel ? `${ariaLabel} — minúty` : 'Minúty'}
      />
      {hasValue && !disabled && (
        <button
          type="button"
          className="dt-clear-btn"
          onClick={clear}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          title="Vymazať čas"
          aria-label="Vymazať čas"
        >
          ×
        </button>
      )}
    </div>
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

  // Pre type="time": potom čo browser zapíše novú hodnotu HH:MM, pre-mapujeme
  // textovú selekciu na pozíciu 3-5, čím sa modré highlight presunie z hodín
  // na minúty. Funguje pri všetkých spôsoboch zadania (klávesnica, šípky,
  // spinner, native picker) — natívny `<input type="time">` v desktopových
  // prehliadačoch akceptuje `setSelectionRange()` na visible texte.
  const handleChange = (e) => {
    const el = e.target;
    const newVal = el.value;
    onChange(newVal);
    if (type === 'time' && newVal && /^\d{2}:/.test(newVal)) {
      // requestAnimationFrame zabezpečí že selekciu nastavíme až po tom,
      // čo browser dokončí svoj vlastný re-render po zmene hodnoty.
      requestAnimationFrame(() => {
        try { el.setSelectionRange(3, 5); } catch { /* niektoré browsery
          (najmä iOS) odmietajú setSelectionRange na time inpute — tam
          natívny picker beztak rieši UX vlastným wheel widgetom. */ }
      });
    }
  };

  const hasValue = !!value;

  return (
    <div className={`dt-input-wrapper ${disabled ? 'dt-disabled' : ''}`} style={style}>
      <input
        ref={inputRef}
        type={type}
        value={value || ''}
        onChange={handleChange}
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
