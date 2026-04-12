import { useState, useEffect } from 'react';
import api from '../api/api';

/**
 * Reusable image preview component for file attachments.
 * Downloads the file as blob and renders a thumbnail.
 * Retries once on timeout (MongoDB M0 cold starts can be slow).
 *
 * @param {string} downloadUrl - API endpoint to download the file
 * @param {string} alt - Alt text for the image
 */
function FilePreviewImage({ downloadUrl, alt }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let url = null;
    let cancelled = false;
    let retryTimer = null;

    const fetchImage = (attempt = 1) => {
      api.get(downloadUrl, {
        responseType: 'blob',
        timeout: 45000 // 45s — allows for cold start + large file
      })
        .then(res => {
          if (cancelled) return;
          if (!res.data || res.data.size === 0) throw new Error('empty');
          url = window.URL.createObjectURL(res.data);
          setSrc(url);
          setRetrying(false);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 2) {
            // Retry once after 2s (cold start recovery)
            setRetrying(true);
            retryTimer = setTimeout(() => {
              if (!cancelled) fetchImage(2);
            }, 2000);
          } else {
            setRetrying(false);
            setError(true);
          }
        });
    };

    fetchImage();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (url) window.URL.revokeObjectURL(url);
    };
  }, [downloadUrl]);

  if (error) return <div className="file-icon" title="Náhľad sa nepodarilo načítať">🖼️</div>;
  if (!src) return <div className="file-icon">{retrying ? '🔄' : '⏳'}</div>;
  return <img src={src} alt={alt} />;
}

export default FilePreviewImage;
