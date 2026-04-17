import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { reportError, installGlobalErrorHandlers } from './utils/reportError';
import './styles/index.css';

// Zachytí unhandled errors + promise rejections a pošle do /api/errors/client
// (SuperAdmin → Diagnostics → Chyby). Beží paralelne so Sentry.
installGlobalErrorHandlers();

// Minimal local error boundary — renders fallback UI without requiring the
// Sentry bundle on first paint. Sentry still captures errors via its global
// handlers once it finishes loading (see deferred init below).
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, errorInfo) {
    reportError({
      name: error?.name,
      message: error?.message || 'React render error',
      stack: error?.stack,
      componentStack: errorInfo?.componentStack
    });
  }
  reset = () => this.setState({ hasError: false });
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
        <h2 style={{ color: '#EF4444', marginBottom: '12px' }}>Nastala neocakavana chyba</h2>
        <p style={{ color: '#64748b', marginBottom: '20px' }}>
          Skuste obnovit stranku.
        </p>
        <button
          onClick={this.reset}
          style={{
            padding: '10px 24px', background: '#6366f1', color: '#fff',
            border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px'
          }}
        >
          Obnovit stranku
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);

// Defer Sentry init — previously static-imported at the top of this file,
// which pulled ~100 KB of gzipped JS (including Replay integration) onto the
// critical path and cost ~500 ms on LCP for mobile visitors. The dynamic
// import keeps Sentry in its own chunk (see vite.config manualChunks) AND
// delays fetching it until the browser is idle.
const isNativeIOSApp = /PrplCRM-iOS/.test(navigator.userAgent) ||
  !!(window.webkit && window.webkit.messageHandlers);
if (import.meta.env.VITE_SENTRY_DSN && !isNativeIOSApp) {
  const start = () => {
    import('./utils/sentry').then(m => m.default()).catch(() => {});
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(start, { timeout: 3000 });
  } else {
    setTimeout(start, 1500);
  }
}
