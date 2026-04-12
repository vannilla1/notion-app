import { useState, useEffect, useCallback } from 'react';
import api from '../api/api';
import { downloadBlob } from '../utils/fileDownload';

const getFileIcon = (mimetype) => {
  if (mimetype?.startsWith('image/')) return '🖼️';
  if (mimetype?.includes('pdf')) return '📄';
  if (mimetype?.includes('word') || mimetype?.includes('document')) return '📝';
  if (mimetype?.includes('sheet') || mimetype?.includes('excel')) return '📊';
  if (mimetype?.includes('presentation') || mimetype?.includes('powerpoint')) return '📽️';
  if (mimetype?.startsWith('video/')) return '🎬';
  if (mimetype?.startsWith('audio/')) return '🎵';
  return '📎';
};

const formatFileSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const isTextFile = (mimetype, filename) => {
  if (mimetype?.startsWith('text/')) return true;
  const textExtensions = ['.json', '.xml', '.csv', '.md', '.js', '.ts', '.css', '.html', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.sql', '.sh', '.yml', '.yaml', '.txt'];
  return textExtensions.some(ext => filename?.toLowerCase().endsWith(ext));
};

const isOfficeDocument = (mimetype) => {
  const officeTypes = [
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ];
  return officeTypes.includes(mimetype);
};

/**
 * Universal file preview modal.
 * Supports images, PDFs, video, audio, text files, and office documents.
 *
 * @param {Object} file - File metadata { id, originalName, mimetype, size }
 * @param {string} downloadUrl - API endpoint to download the file blob
 * @param {Function} onClose - Called when modal is closed
 */
function FilePreviewModal({ file, downloadUrl, onClose }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [textContent, setTextContent] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const fetchBlob = useCallback(async () => {
    const response = await api.get(downloadUrl, {
      responseType: 'blob',
      timeout: 45000
    });
    const blob = response.data;
    if (!blob || blob.size === 0) throw new Error('empty');
    return blob;
  }, [downloadUrl]);

  useEffect(() => {
    let blobUrl = null;
    let cancelled = false;

    const loadPreview = async () => {
      setLoading(true);
      setError(null);
      setTextContent(null);
      setPreviewUrl(null);

      try {
        let blob;
        try {
          blob = await fetchBlob();
        } catch (firstError) {
          // Retry once after 2s (cold start recovery)
          const isTimeout = firstError.code === 'ECONNABORTED' || firstError.message?.includes('timeout');
          const isNetwork = !firstError.response;
          if (isTimeout || isNetwork) {
            await new Promise(r => setTimeout(r, 2000));
            blob = await fetchBlob();
          } else {
            throw firstError;
          }
        }

        if (cancelled) return;

        // Text file content
        if (isTextFile(file.mimetype, file.originalName)) {
          const text = await blob.text();
          if (!cancelled) setTextContent(text);
        }

        blobUrl = URL.createObjectURL(blob);
        if (!cancelled) setPreviewUrl(blobUrl);
      } catch (err) {
        if (cancelled) return;
        let msg = 'Neznáma chyba';
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          msg = 'Časový limit vypršal — skúste to znova';
        } else if (err.message === 'empty') {
          msg = 'Prázdna odpoveď zo servera';
        } else if (err.response?.status) {
          msg = `Server vrátil chybu ${err.response.status}`;
          try {
            if (err.response?.data instanceof Blob) {
              const text = await err.response.data.text();
              const json = JSON.parse(text);
              if (json.message) msg = json.message;
            }
          } catch {}
        } else {
          msg = err.message || 'Neznáma chyba';
        }
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadPreview();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [file, fetchBlob]);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const response = await api.get(downloadUrl, {
        responseType: 'blob',
        timeout: 60000
      });
      downloadBlob(response.data, file.originalName);
    } catch {
      // Fallback — open in new tab
      if (previewUrl) {
        const a = document.createElement('a');
        a.href = previewUrl;
        a.download = file.originalName;
        a.click();
      }
    } finally {
      setDownloading(false);
    }
  };

  const isPdf = file.mimetype === 'application/pdf' || file.originalName?.toLowerCase().endsWith('.pdf');

  return (
    <div className="modal-overlay file-preview-overlay" onClick={onClose}>
      <div className="file-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-preview-header">
          <h3>{file.originalName}</h3>
          <div className="file-preview-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleDownload}
              disabled={downloading}
            >
              {downloading ? '⏳ Sťahujem...' : '⬇️ Stiahnuť'}
            </button>
            <button className="btn-icon file-preview-close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="file-preview-content">
          {loading ? (
            <div className="preview-loading">
              <span>Načítavam náhľad...</span>
            </div>
          ) : error ? (
            <div className="preview-error">
              <span className="preview-icon">⚠️</span>
              <p>{error}</p>
              <button className="btn btn-primary" onClick={handleDownload}>
                Stiahnuť súbor
              </button>
            </div>
          ) : file.mimetype?.startsWith('image/') && previewUrl ? (
            <img
              src={previewUrl}
              alt={file.originalName}
              className="preview-image"
            />
          ) : isPdf && previewUrl ? (
            <object
              data={previewUrl}
              type="application/pdf"
              className="preview-pdf"
            >
              <div className="preview-pdf-fallback">
                <span className="preview-icon">📄</span>
                <p>PDF náhľad nie je dostupný v tomto prehliadači</p>
                <button className="btn btn-primary" onClick={handleDownload}>
                  Stiahnuť PDF
                </button>
              </div>
            </object>
          ) : file.mimetype?.startsWith('video/') && previewUrl ? (
            <video src={previewUrl} controls className="preview-video">
              Váš prehliadač nepodporuje prehrávanie videa.
            </video>
          ) : file.mimetype?.startsWith('audio/') && previewUrl ? (
            <div className="preview-audio">
              <span className="preview-icon">🎵</span>
              <audio src={previewUrl} controls className="audio-player">
                Váš prehliadač nepodporuje prehrávanie audia.
              </audio>
            </div>
          ) : isTextFile(file.mimetype, file.originalName) && textContent !== null ? (
            <div className="preview-text">
              <pre>{textContent}</pre>
            </div>
          ) : isOfficeDocument(file.mimetype) && previewUrl ? (
            <div className="preview-office">
              <span className="preview-icon">{getFileIcon(file.mimetype)}</span>
              <p>Pre zobrazenie Office dokumentov stiahnite súbor</p>
              <button className="btn btn-primary" onClick={handleDownload}>
                Stiahnuť a otvoriť
              </button>
            </div>
          ) : (
            <div className="preview-generic">
              <span className="preview-icon">{getFileIcon(file.mimetype)}</span>
              <p className="file-info-text">
                <strong>{file.originalName}</strong>
                <br />
                Typ: {file.mimetype || 'Neznámy'}
                <br />
                Veľkosť: {formatFileSize(file.size)}
              </p>
              <button className="btn btn-primary" onClick={handleDownload}>
                Stiahnuť súbor
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FilePreviewModal;
