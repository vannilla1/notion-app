import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import initSentry from './utils/sentry';
import './styles/index.css';

// Initialize Sentry before rendering
initSentry();

const SentryErrorBoundary = import.meta.env.VITE_SENTRY_DSN
  ? Sentry.ErrorBoundary
  : React.Fragment;

const errorBoundaryProps = import.meta.env.VITE_SENTRY_DSN
  ? {
      fallback: ({ error, resetError }) => (
        <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#EF4444', marginBottom: '12px' }}>Nastala neocakavana chyba</h2>
          <p style={{ color: '#64748b', marginBottom: '20px' }}>
            Chyba bola automaticky nahlasena. Skuste obnovit stranku.
          </p>
          <button
            onClick={resetError}
            style={{
              padding: '10px 24px', background: '#6366f1', color: '#fff',
              border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '14px'
            }}
          >
            Obnovit stranku
          </button>
        </div>
      ),
      showDialog: false,
    }
  : {};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SentryErrorBoundary {...errorBoundaryProps}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </SentryErrorBoundary>
  </React.StrictMode>
);
