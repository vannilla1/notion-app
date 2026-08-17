/**
 * Stiahnutie blobu — web, iOS shell aj Android shell.
 *
 * Každá platforma potrebuje inú cestu:
 *  - iOS   → WKScriptMessage 'fileDownload' (base64) → share sheet
 *  - Android → NativeBridge.saveFile (base64) → priečinok Stiahnuté
 *              (WebView bez tohto nestiahne NIČ — blob: aj <a download>
 *               sú tichý no-op; do 1.0.5 tam sťahovanie vôbec nefungovalo)
 *  - web   → <a download> s object URL
 *
 * Veľké súbory (hromadný ZIP) NEIDÚ cez túto funkciu — tam sa naviguje
 * priamo na odkaz a shell si to zoberie natívne (iOS share sheet /
 * Android DownloadManager), bez base64 v pamäti.
 */
const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
  reader.readAsDataURL(blob);
});

export function downloadBlob(blob, fileName) {
  // iOS shell
  if (window.webkit?.messageHandlers?.fileDownload) {
    toBase64(blob).then(base64 => {
      window.webkit.messageHandlers.fileDownload.postMessage({
        data: base64,
        fileName,
        mimetype: blob.type || 'application/octet-stream'
      });
    }).catch(() => alert('Súbor sa nepodarilo pripraviť na stiahnutie.'));
    return;
  }

  // Android shell — feature detection, nie user-agent: v teréne zostávajú
  // staršie APK bez saveFile a tie musia dostať zrozumiteľnú hlášku,
  // nie tichý no-op.
  if (window.NativeBridge) {
    if (typeof window.NativeBridge.saveFile !== 'function') {
      alert('Sťahovanie súborov vyžaduje novšiu verziu aplikácie. Aktualizujte ju v Google Play.');
      return;
    }
    toBase64(blob).then(base64 => {
      const res = window.NativeBridge.saveFile(base64, fileName, blob.type || 'application/octet-stream');
      if (res && String(res).startsWith('error')) {
        alert('Súbor sa nepodarilo uložiť do priečinka Stiahnuté.');
      }
      // Úspech hlási natívny Toast — bez duplicitnej web hlášky
    }).catch(() => alert('Súbor sa nepodarilo pripraviť na stiahnutie.'));
    return;
  }

  // Web
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
