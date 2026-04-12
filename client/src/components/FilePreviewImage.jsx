import { useState, useEffect } from 'react';
import api from '../api/api';

/**
 * Reusable image preview component for file attachments.
 * Downloads the file as blob and renders a thumbnail.
 *
 * @param {string} downloadUrl - API endpoint to download the file (e.g. /api/tasks/123/files/abc/download)
 * @param {string} alt - Alt text for the image
 */
function FilePreviewImage({ downloadUrl, alt }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let url = null;
    let cancelled = false;
    api.get(downloadUrl, {
      responseType: 'blob',
      timeout: 20000
    })
      .then(res => {
        if (cancelled) return;
        url = window.URL.createObjectURL(res.data);
        setSrc(url);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (url) window.URL.revokeObjectURL(url); };
  }, [downloadUrl]);

  if (error) return <div className="file-icon" title="Náhľad sa nepodarilo načítať">🖼️</div>;
  if (!src) return <div className="file-icon">⏳</div>;
  return <img src={src} alt={alt} />;
}

export default FilePreviewImage;
