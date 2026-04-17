import { useEffect, useState } from 'react';
import {
  isPushSupported,
  getPermissionStatus,
  subscribeToPush,
  isSubscribedToPush
} from '../services/pushNotifications';

/**
 * Nenápadný bottom banner ktorý na prvý session po prihlásení ponúkne
 * Androidu/PWA userom zapnúť push notifikácie. Bez tohto kroku by museli
 * sami nájsť Nastavenia → Notifikácie a toggle, čo väčšina userov nespraví.
 *
 * Zobrazí sa LEN keď:
 *   - isPushSupported() === true  (nie iOS native app, má ServiceWorker + Push API)
 *   - Notification.permission === 'default'  (user sa ešte nerozhodol)
 *   - nie je dismissed v localStorage
 *   - user je prihlásený (banner sa mount-uje iba vnútri authenticated tree)
 *
 * Po kliku "Zapnúť" zavolá subscribeToPush(), ktorý vyvolá systémové permission
 * dialogy Androidu/Chrome a uloží subscription na backend.
 *
 * User gesture požiadavka: Chrome/TWA vyžadujú user interaction pre
 * requestPermission() → preto banner má explicit button, nikdy auto-call.
 */
const DISMISS_KEY = 'pushPermissionBannerDismissedUntil';
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dní

const isDismissed = () => {
  try {
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    return until > Date.now();
  } catch {
    return false;
  }
};

const markDismissed = () => {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DURATION_MS));
  } catch {
    /* localStorage disabled — banner sa objaví nabudúce, acceptable */
  }
};

const PushPermissionBanner = () => {
  const [visible, setVisible] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Android-only — desktop users majú browser notification UI (icon v URL
      // bare) a vedia si to zapnúť sami. Banner by tam bol rušivý.
      const isAndroid = /Android/i.test(navigator.userAgent || '');
      if (!isAndroid) return;

      if (!isPushSupported()) return;
      if (isDismissed()) return;
      if (getPermissionStatus() !== 'default') return;

      // Ak už subscription existuje (napr. re-install ale cache SW drží sub),
      // banner nepotrebujeme.
      try {
        const already = await isSubscribedToPush();
        if (already) return;
      } catch {
        /* ignore — zobrazíme banner, user si môže zapnúť manuálne */
      }

      // Delay 2s po mount — nechceme ruptnúť user UX okamžite po otvorení
      // appky. Dá to čas loaderom a shimmers dobehnúť.
      const timer = setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, 2000);
      return () => clearTimeout(timer);
    })();

    return () => { cancelled = true; };
  }, []);

  const handleEnable = async () => {
    setWorking(true);
    setError(null);
    try {
      await subscribeToPush();
      setVisible(false);
    } catch (e) {
      // Najčastejšie: user zamietol system dialog → permission 'denied'.
      // V tom prípade banner skryjeme navždy (nemá zmysel pýtať znova bez
      // toho aby sa user vedome vrátil do Nastavení).
      if (getPermissionStatus() === 'denied') {
        markDismissed();
        setVisible(false);
      } else {
        setError(e?.message || 'Nepodarilo sa zapnúť notifikácie');
      }
    } finally {
      setWorking(false);
    }
  };

  const handleDismiss = () => {
    markDismissed();
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="push-permission-banner" role="dialog" aria-live="polite">
      <div className="ppb-content">
        <span className="ppb-icon" aria-hidden="true">🔔</span>
        <div className="ppb-text">
          <strong>Zapnite notifikácie</strong>
          <p>Dostávajte upozornenia na nové úlohy, správy a aktivitu v tíme — aj keď nie ste v appke.</p>
          {error && <p className="ppb-error">{error}</p>}
        </div>
      </div>
      <div className="ppb-actions">
        <button
          type="button"
          className="ppb-btn-secondary"
          onClick={handleDismiss}
          disabled={working}
        >
          Neskôr
        </button>
        <button
          type="button"
          className="ppb-btn-primary"
          onClick={handleEnable}
          disabled={working}
        >
          {working ? 'Moment…' : 'Zapnúť'}
        </button>
      </div>
      <style>{styles}</style>
    </div>
  );
};

const styles = `
  .push-permission-banner {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 72px);
    z-index: 9998;
    background: #1f2937;
    color: #f9fafb;
    border-radius: 14px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: ppb-slide-up 0.3s ease;
    max-width: 520px;
    margin-left: auto;
    margin-right: auto;
  }

  @keyframes ppb-slide-up {
    from { transform: translateY(24px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .ppb-content {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .ppb-icon {
    font-size: 28px;
    line-height: 1;
    flex-shrink: 0;
  }

  .ppb-text strong {
    display: block;
    font-size: 15px;
    margin-bottom: 4px;
    color: #fff;
  }

  .ppb-text p {
    margin: 0;
    font-size: 13px;
    line-height: 1.4;
    color: #d1d5db;
  }

  .ppb-error {
    color: #fca5a5 !important;
    margin-top: 6px !important;
  }

  .ppb-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .ppb-btn-secondary,
  .ppb-btn-primary {
    padding: 10px 18px;
    border-radius: 10px;
    border: none;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    min-height: 44px;
  }

  .ppb-btn-secondary {
    background: transparent;
    color: #9ca3af;
  }

  .ppb-btn-secondary:hover:not(:disabled) {
    color: #d1d5db;
  }

  .ppb-btn-primary {
    background: #6366f1;
    color: #fff;
  }

  .ppb-btn-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .ppb-btn-primary:active:not(:disabled),
  .ppb-btn-secondary:active:not(:disabled) {
    transform: scale(0.97);
  }

  .ppb-btn-primary:disabled,
  .ppb-btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 480px) {
    .push-permission-banner {
      bottom: calc(env(safe-area-inset-bottom, 0px) + 68px);
    }
  }
`;

export default PushPermissionBanner;
