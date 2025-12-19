import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';
import Sidebar from '../components/Sidebar';
import PageView from '../components/PageView';

function Workspace() {
  const { user, logout } = useAuth();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { onPageCreated, onPageDeleted } = useSocket();

  useEffect(() => {
    fetchPages();
  }, []);

  useEffect(() => {
    const unsubCreate = onPageCreated((page) => {
      setPages((prev) => {
        if (prev.find(p => p.id === page.id)) return prev;
        return [...prev, page];
      });
    });

    const unsubDelete = onPageDeleted(({ pageId }) => {
      setPages((prev) => prev.filter(p => p.id !== pageId));
    });

    return () => {
      if (unsubCreate) unsubCreate();
      if (unsubDelete) unsubDelete();
    };
  }, [onPageCreated, onPageDeleted]);

  const fetchPages = async () => {
    try {
      const res = await axios.get('/api/pages');
      setPages(res.data);
    } catch (error) {
      console.error('Failed to fetch pages:', error);
    } finally {
      setLoading(false);
    }
  };

  const createPage = async () => {
    try {
      const res = await axios.post('/api/pages', {
        title: 'Untitled',
        icon: '📄'
      });
      setPages([...pages, res.data]);
      navigate(`/page/${res.data.id}`);
    } catch (error) {
      console.error('Failed to create page:', error);
    }
  };

  const deletePage = async (pageId) => {
    try {
      await axios.delete(`/api/pages/${pageId}`);
      setPages(pages.filter(p => p.id !== pageId));
      navigate('/');
    } catch (error) {
      console.error('Failed to delete page:', error);
    }
  };

  const updatePageInList = (updatedPage) => {
    setPages(pages.map(p => p.id === updatedPage.id ? updatedPage : p));
  };

  return (
    <div className="app-container">
      <Sidebar
        user={user}
        pages={pages}
        onCreatePage={createPage}
        onDeletePage={deletePage}
        onLogout={logout}
        loading={loading}
      />
      <main className="main-content">
        <Routes>
          <Route
            path="/"
            element={
              <div className="empty-state">
                <div className="empty-state-icon">📝</div>
                <h2 className="empty-state-title">Select a page</h2>
                <p className="empty-state-text">
                  Choose a page from the sidebar or create a new one
                </p>
              </div>
            }
          />
          <Route
            path="/page/:pageId"
            element={
              <PageViewWrapper
                onUpdate={updatePageInList}
              />
            }
          />
        </Routes>
      </main>
    </div>
  );
}

function PageViewWrapper({ onUpdate }) {
  const { pageId } = useParams();
  return <PageView key={pageId} pageId={pageId} onUpdate={onUpdate} />;
}

export default Workspace;
