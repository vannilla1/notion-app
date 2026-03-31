/**
 * Download a blob, using iOS native share sheet when in WKWebView,
 * or standard blob URL approach on desktop browsers.
 */
export function downloadBlob(blob, fileName) {
  // iOS WKWebView — use native share sheet via JS bridge
  if (window.webkit?.messageHandlers?.fileDownload) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      window.webkit.messageHandlers.fileDownload.postMessage({
        data: base64,
        fileName: fileName,
        mimetype: blob.type || 'application/octet-stream'
      });
    };
    reader.readAsDataURL(blob);
    return;
  }

  // Desktop — standard blob download
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
