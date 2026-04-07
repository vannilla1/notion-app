import { useNavigate } from 'react-router-dom';

/**
 * UpgradePrompt — shown when a user hits a plan limit.
 * Usage: <UpgradePrompt message="Váš plán umožňuje max. 5 kontaktov." />
 */
function UpgradePrompt({ message, onClose }) {
  const navigate = useNavigate();

  return (
    <div className="upgrade-prompt">
      <div className="upgrade-prompt-icon">🔒</div>
      <p className="upgrade-prompt-message">{message}</p>
      <div className="upgrade-prompt-actions">
        <button
          className="upgrade-prompt-btn"
          onClick={() => navigate('/app/billing')}
        >
          Zobraziť plány
        </button>
        {onClose && (
          <button className="upgrade-prompt-close" onClick={onClose}>
            Zavrieť
          </button>
        )}
      </div>
    </div>
  );
}

export default UpgradePrompt;
