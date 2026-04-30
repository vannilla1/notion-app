import { useNavigate } from 'react-router-dom';
import { isIosNativeApp } from '../utils/platform';

/**
 * UpgradePrompt — shown when a user hits a plan limit.
 * Usage: <UpgradePrompt message="Váš plán umožňuje max. 5 kontaktov." />
 *
 * iOS native: hides the "Zobraziť plány" CTA and shows only the message,
 * per App Store guideline 3.1.3(d) (Reader app exception). Plan management
 * happens on the web; the iOS app must not link to a purchasing flow.
 */
function UpgradePrompt({ message, onClose }) {
  const navigate = useNavigate();
  const iosNative = isIosNativeApp();

  return (
    <div className="upgrade-prompt">
      <div className="upgrade-prompt-icon">🔒</div>
      <p className="upgrade-prompt-message">{message}</p>
      <div className="upgrade-prompt-actions">
        {!iosNative && (
          <button
            className="upgrade-prompt-btn"
            onClick={() => navigate('/app/billing')}
          >
            Zobraziť plány
          </button>
        )}
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
