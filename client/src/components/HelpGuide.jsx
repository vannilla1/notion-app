import { useState, useEffect } from 'react';

// Check if user has seen help for a specific section
const hasSeenHelp = (section) => {
  const seen = localStorage.getItem(`help_seen_${section}`);
  return seen === 'true';
};

// Mark help as seen for a specific section
const markHelpAsSeen = (section) => {
  localStorage.setItem(`help_seen_${section}`, 'true');
};

// Reset all help (for testing or user request)
export const resetAllHelp = () => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('help_seen_'));
  keys.forEach(k => localStorage.removeItem(k));
};

/**
 * HelpGuide component - shows a help modal with tips for each section
 */
const HelpGuide = ({ section, tips, title, children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showButton, setShowButton] = useState(true);

  useEffect(() => {
    // Auto-show help if user hasn't seen it yet
    if (!hasSeenHelp(section)) {
      setIsOpen(true);
    }
  }, [section]);

  const handleClose = () => {
    setIsOpen(false);
    markHelpAsSeen(section);
  };

  const handleOpen = () => {
    setIsOpen(true);
  };

  return (
    <>
      {/* Help button */}
      {showButton && (
        <button
          className="help-guide-btn"
          onClick={handleOpen}
          title="Zobraziť nápovedu"
        >
          ?
        </button>
      )}

      {/* Help modal */}
      {isOpen && (
        <div className="help-guide-overlay" onClick={handleClose}>
          <div className="help-guide-modal" onClick={e => e.stopPropagation()}>
            <div className="help-guide-header">
              <h2>{title || 'Nápoveda'}</h2>
              <button className="help-guide-close" onClick={handleClose}>×</button>
            </div>
            <div className="help-guide-content">
              {tips && tips.length > 0 ? (
                <ul className="help-guide-tips">
                  {tips.map((tip, index) => (
                    <li key={index} className="help-guide-tip">
                      <span className="tip-icon">{tip.icon || '💡'}</span>
                      <div className="tip-content">
                        <strong>{tip.title}</strong>
                        <p>{tip.description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : children}
            </div>
            <div className="help-guide-footer">
              <button className="help-guide-got-it" onClick={handleClose}>
                Rozumiem
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .help-guide-btn {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          color: white;
          border: none;
          font-size: 20px;
          font-weight: bold;
          cursor: pointer;
          box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
          z-index: 1000;
          transition: all 0.3s ease;
        }

        .help-guide-btn:hover {
          transform: scale(1.1);
          box-shadow: 0 6px 20px rgba(99, 102, 241, 0.5);
        }

        .help-guide-overlay {
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
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .help-guide-modal {
          background: var(--card-bg, #1e1e2e);
          border-radius: 16px;
          max-width: 500px;
          width: 100%;
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          animation: slideUp 0.3s ease;
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .help-guide-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 24px;
          border-bottom: 1px solid var(--border-color, #333);
        }

        .help-guide-header h2 {
          margin: 0;
          font-size: 20px;
          color: var(--text-primary, #fff);
        }

        .help-guide-close {
          background: none;
          border: none;
          color: var(--text-secondary, #888);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          line-height: 1;
          transition: color 0.2s;
        }

        .help-guide-close:hover {
          color: var(--text-primary, #fff);
        }

        .help-guide-content {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }

        .help-guide-tips {
          list-style: none;
          padding: 0;
          margin: 0;
        }

        .help-guide-tip {
          display: flex;
          gap: 16px;
          padding: 16px 0;
          border-bottom: 1px solid var(--border-color, #333);
        }

        .help-guide-tip:last-child {
          border-bottom: none;
        }

        .tip-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .tip-content {
          flex: 1;
        }

        .tip-content strong {
          display: block;
          color: var(--text-primary, #fff);
          margin-bottom: 4px;
          font-size: 15px;
        }

        .tip-content p {
          margin: 0;
          color: var(--text-secondary, #aaa);
          font-size: 14px;
          line-height: 1.5;
        }

        .help-guide-footer {
          padding: 16px 24px;
          border-top: 1px solid var(--border-color, #333);
          display: flex;
          justify-content: flex-end;
        }

        .help-guide-got-it {
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

        .help-guide-got-it:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
        }

        @media (max-width: 600px) {
          .help-guide-modal {
            max-height: 90vh;
            margin: 10px;
          }

          .help-guide-btn {
            bottom: 80px;
          }
        }
      `}</style>
    </>
  );
};

export default HelpGuide;
