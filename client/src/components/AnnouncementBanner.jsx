import { useEffect, useState, useCallback } from 'react';
import api from '../api/api';
import { isIosNativeApp } from '../utils/platform';

/**
 * AnnouncementBanner — universal in-app announcement system.
 *
 * Pri mounte načíta z `/api/announcements/active` zoznam announcementov
 * ktoré má prihlásený user vidieť. Backend filtruje podľa:
 *  - active range (od/do)
 *  - dismissed flag (user už dismissol)
 *  - hasMobileApp signál (FcmDevice/APNsDevice → user už appku má)
 *
 * Renderuje sa ako pill v hlavičke (vedľa zvončeka), klik otvorí modal s
 * detailom. Smart-adaptívne CTA podľa current device User-Agenta — Android
 * users vidia primárny Google Play link, iPhone users vidia "App Store
 * čoskoro" disabled badge ako primárny.
 */

const detectCurrentDevice = () => {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'desktop';
};

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([]);
  const [activeId, setActiveId] = useState(null); // currently open in modal

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/announcements/active');
      setAnnouncements(res.data?.announcements || []);
    } catch {
      setAnnouncements([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDismiss = async (id, e) => {
    if (e) e.stopPropagation();
    try {
      await api.post(`/api/announcements/${id}/dismiss`);
    } catch { /* offline ok */ }
    setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    if (activeId === id) setActiveId(null);
  };

  if (announcements.length === 0) return null;

  // Pre jednoduchosť ukazujeme len 1 najnovší announcement v pille (prvý v poli).
  // Ak ich bude v budúcnosti viac aktívnych naraz, dá sa rozšíriť do "n nových"
  // counter-u s dropdown listom.
  const current = announcements[0];

  return (
    <>
      <button
        className="announcement-pill"
        onClick={() => setActiveId(current.id)}
        title={current.title}
        aria-label={`Otvoriť oznam: ${current.title}`}
      >
        <span className="announcement-pill-icon">{current.icon || '✨'}</span>
        <span className="announcement-pill-label">{current.pillLabel || 'Nové'}</span>
      </button>

      {activeId && (
        <AnnouncementModal
          announcement={announcements.find((a) => a.id === activeId) || current}
          onClose={() => setActiveId(null)}
          onDismiss={() => handleDismiss(activeId)}
        />
      )}
    </>
  );
}

function AnnouncementModal({ announcement, onClose, onDismiss }) {
  const device = detectCurrentDevice();
  const inIosShell = isIosNativeApp();
  const cta = announcement.cta || {};

  // Smart primary CTA based on current device:
  //   android → Google Play (active)
  //   ios     → App Store (disabled until live)
  //   desktop → Google Play (active, sekundárny App Store)
  // V iOS shell-e nikdy neukazujeme aktívny external link na Play Store —
  // Apple by to mohol považovať za external purchase mechanism.
  const showGooglePlay = !inIosShell;
  const showAppStore = true;

  return (
    <div className="announcement-modal-overlay" onClick={onClose}>
      <div className="announcement-modal" onClick={(e) => e.stopPropagation()}>
        <button className="announcement-modal-close" onClick={onClose} aria-label="Zatvoriť">×</button>

        <div className="announcement-modal-header">
          <div className="announcement-modal-icon">{announcement.icon || '✨'}</div>
          <h2 className="announcement-modal-title">{announcement.title}</h2>
        </div>

        <p className="announcement-modal-body">{announcement.body}</p>

        <div className="announcement-modal-cta">
          {showGooglePlay && cta.googlePlay && (
            <a
              href={cta.googlePlay.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`announcement-cta-btn announcement-cta-primary ${device === 'ios' ? 'announcement-cta-secondary' : ''}`}
            >
              <span className="announcement-cta-icon">▶</span>
              <span className="announcement-cta-label">
                <small>Dostupné na</small>
                <strong>Google Play</strong>
              </span>
            </a>
          )}
          {showAppStore && cta.appStore && (
            <span
              className={`announcement-cta-btn announcement-cta-disabled ${device === 'ios' ? 'announcement-cta-primary' : ''}`}
              title="App Store verzia je v Apple review"
            >
              <span className="announcement-cta-icon"></span>
              <span className="announcement-cta-label">
                <small>{cta.appStore.label || 'Pripravujeme'}</small>
                <strong>App Store</strong>
              </span>
            </span>
          )}
        </div>

        <div className="announcement-modal-footer">
          <button className="announcement-modal-dismiss" onClick={onDismiss}>
            Nezobrazovať znova
          </button>
        </div>
      </div>
    </div>
  );
}
