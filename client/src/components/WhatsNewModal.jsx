import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getUnseenModalNews, markAllNewsSeen, formatNewsDate, SECTION_LABELS } from '../utils/changelog';

/**
 * Jednorazové okno „Čo je nové" — zobrazí sa na hlavnej stránke (/app) pri
 * prvom prihlásení po vydaní noviniek. Obsah kŕmi centrálny register
 * utils/changelog.js; po zavretí sa všetko označí ako videné (per používateľ),
 * takže sa už neukáže — novinky ale ostávajú trvalo v otázniku (?) na
 * príslušných stránkach.
 *
 * Novým používateľom (prvá návšteva — ešte nevideli ani nápovedu Dashboardu)
 * sa okno nezobrazuje: všetko je pre nich „nové" a vyskočí im nápoveda;
 * changelog by bol duplicitný šum. Stav sa im len ticho zapíše.
 */
function WhatsNewModal() {
  const { user } = useAuth();
  const [news, setNews] = useState([]);

  useEffect(() => {
    if (!user?.id) return;
    let isFirstVisit = true;
    try {
      isFirstVisit = localStorage.getItem('help_seen_dashboard') !== 'true';
    } catch { /* noop */ }
    if (isFirstVisit) {
      markAllNewsSeen(user.id);
      return;
    }
    setNews(getUnseenModalNews(user.id));
  }, [user?.id]);

  if (news.length === 0) return null;

  const close = () => {
    markAllNewsSeen(user?.id);
    setNews([]);
  };

  return (
    <>
      <div className="whats-new-overlay" onClick={close}>
        <div className="whats-new-modal" onClick={(e) => e.stopPropagation()}>
          <div className="whats-new-header">
            <h2>🎉 Čo je nové</h2>
            <button className="whats-new-close" onClick={close}>×</button>
          </div>
          <div className="whats-new-content">
            <p className="whats-new-intro">
              Od vášho posledného prihlásenia pribudli tieto novinky. Kedykoľvek
              ich nájdete aj v otázniku (?) na príslušnej stránke.
            </p>
            <ul className="whats-new-list">
              {news.map((n) => (
                <li key={n.v} className="whats-new-item">
                  <span className="whats-new-icon">{n.icon || '🆕'}</span>
                  <div className="whats-new-body">
                    <strong>
                      {n.title}
                      <span className="whats-new-date">{formatNewsDate(n.date)}</span>
                    </strong>
                    <p>{n.description}</p>
                    <div className="whats-new-chips">
                      {n.sections.map((s) => (
                        <span key={s} className="whats-new-chip">📍 {SECTION_LABELS[s] || s}</span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="whats-new-footer">
            <button className="whats-new-got-it" onClick={close}>
              Super, rozumiem
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .whats-new-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          padding: 20px;
          animation: whatsNewFadeIn 0.2s ease;
        }

        @keyframes whatsNewFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .whats-new-modal {
          background: #2a2a3e;
          border-radius: 16px;
          max-width: 540px;
          width: 100%;
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          animation: whatsNewSlideUp 0.3s ease;
        }

        @keyframes whatsNewSlideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .whats-new-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 24px;
          border-bottom: 1px solid #404055;
        }

        .whats-new-header h2 {
          margin: 0;
          font-size: 20px;
          color: #ffffff;
        }

        .whats-new-close {
          background: none;
          border: none;
          color: #9ca3af;
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          line-height: 1;
          transition: color 0.2s;
        }

        .whats-new-close:hover {
          color: #ffffff;
        }

        .whats-new-content {
          padding: 20px 24px;
          overflow-y: auto;
          flex: 1;
        }

        .whats-new-intro {
          margin: 0 0 12px;
          color: #9ca3af;
          font-size: 13px;
          line-height: 1.5;
        }

        .whats-new-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .whats-new-item {
          display: flex;
          gap: 16px;
          padding: 14px 0;
          border-bottom: 1px solid #404055;
        }

        .whats-new-item:last-child {
          border-bottom: none;
        }

        .whats-new-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .whats-new-body {
          flex: 1;
        }

        .whats-new-body strong {
          display: block;
          color: #ffffff;
          margin-bottom: 4px;
          font-size: 15px;
        }

        .whats-new-date {
          color: #9ca3af;
          font-weight: 400;
          font-size: 12px;
          margin-left: 8px;
        }

        .whats-new-body p {
          margin: 0 0 6px;
          color: #d1d5db;
          font-size: 14px;
          line-height: 1.5;
        }

        .whats-new-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .whats-new-chip {
          background: rgba(99, 102, 241, 0.18);
          color: #a5b4fc;
          border-radius: 999px;
          padding: 2px 10px;
          font-size: 11.5px;
          font-weight: 600;
        }

        .whats-new-footer {
          padding: 16px 24px;
          border-top: 1px solid #404055;
          display: flex;
          justify-content: flex-end;
        }

        .whats-new-got-it {
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          color: white;
          border: none;
          padding: 12px 32px;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .whats-new-got-it:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
        }

        @media (max-width: 767px) {
          .whats-new-modal {
            max-height: 88vh;
            margin: 10px;
          }
        }
      `}</style>
    </>
  );
}

export default WhatsNewModal;
