import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';

const HeaderLogo = ({ active, onClick }) => {
  const navigate = useNavigate();
  const { currentWorkspace } = useWorkspace();

  const handleClick = onClick || (() => navigate('/app'));

  return (
    <div className="header-brand" onClick={handleClick}>
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
