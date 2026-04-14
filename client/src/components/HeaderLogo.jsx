import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';

const HeaderLogo = ({ active, onClick }) => {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();

  // On iOS (BottomNav provides Dashboard navigation), the outer div's onClick
  // was firing accidentally when users touched the header area while starting
  // a scroll gesture — WKWebView synthesized a click from small-movement
  // taps on the header-brand <div>, navigating the whole app back to /app.
  // That was the "enter section → try to scroll → jumps to dashboard" bug.
  // Fix: only bind onClick when explicitly provided OR when NOT inside the
  // iOS WebView. The BottomNav already has a Dashboard tab, so desktop keeps
  // the click-to-home behavior and iOS loses nothing.
  const isIosApp = typeof document !== 'undefined' &&
    document.body?.classList?.contains('ios-app');
  const defaultNav = isIosApp ? null : () => navigate('/app');
  const handleClick = onClick || defaultNav;

  return (
    <div
      className="header-brand"
      onClick={handleClick || undefined}
      style={handleClick ? undefined : { cursor: 'default' }}
    >
      <img src="/icons/icon-96x96.png" alt="" width="28" height="28" className="header-logo-icon" />
      <div className="header-brand-text">
        <h1 className={`header-title-link${active ? ' active' : ''}`}>
          Prpl CRM
        </h1>
        {currentWorkspace && (
          <span className="header-workspace-name">
            <span className="header-workspace-dot" style={{ backgroundColor: currentWorkspace.color || '#6366f1' }} />
            {currentWorkspace.name}
          </span>
        )}
      </div>
    </div>
  );
};

export default HeaderLogo;
