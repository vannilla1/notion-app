export function downloadBlob(blob, fileName) {
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

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
