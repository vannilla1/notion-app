import { useState } from 'react';

/**
 * Rozbaľovací manuál na konci každého AdminPanel tabu.
 *
 * Defaultne zatvorený — admin si ho otvorí keď potrebuje pripomenutie
 * čo dané tlačidlo / sekcia robí. Kompletne lokálny state (žiadny
 * localStorage), aby nezaberal storage a aby pri refreshi začínal vždy
 * v tichom režime.
 *
 * Štýly inline aby som nemusel pridávať CSS triedy do globálneho CSS —
 * tento komponent je čisto AdminPanel-only.
 *
 * Props:
 *   title: krátky názov manuálu (napr. "Overview", "Používatelia")
 *   children: obsah manuálu — ľubovoľné JSX (typicky <ul>/<li> + <p>)
 */
function AdminHelpToggle({ title, children }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        marginTop: '32px',
        border: '1px solid var(--border-color, #e2e8f0)',
        borderRadius: 'var(--radius, 8px)',
        background: 'var(--bg-secondary, #f8fafc)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          textAlign: 'left',
        }}
        title={open ? 'Skryť manuál' : 'Zobraziť manuál'}
      >
        <span>📖 Manuál — {title}</span>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {open ? '▲ skryť' : '▼ zobraziť'}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: '0 20px 20px',
            fontSize: '13px',
            lineHeight: 1.6,
            color: 'var(--text-primary)',
            borderTop: '1px solid var(--border-color, #e2e8f0)',
            paddingTop: '16px',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default AdminHelpToggle;
