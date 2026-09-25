/**
 * Zmenšenie fotky v prehliadači pred nahratím (profilová fotka).
 *
 * Avatar sa ukladá ako base64 priamo v dokumente používateľa (limit 5 MB,
 * server/routes/auth.js). Fotka z fotoaparátu má bežne 3–8 MB — od Androidu
 * 1.0.10 sa dá odfotiť priamo z appky, takže by „Nahrať fotku" často skončilo
 * hláškou o veľkosti. Avatar sa zobrazuje najviac v desiatkach pixelov, takže
 * 512 px JPEG (~50–150 kB) stačí s rezervou. PNG/WebP (možná priehľadnosť)
 * sa zmenšia do PNG.
 *
 * Bezpečné zlyhanie: keď prehliadač obrázok nevie dekódovať (napr. HEIC mimo
 * Safari), nemá canvas, alebo by výsledok nebol menší, vráti PÔVODNÝ súbor —
 * rozhodne potom limit/filter ako doteraz. GIF sa nezmenšuje (stratil by
 * animáciu). Orientáciu z EXIF prehliadače aplikujú pri dekódovaní <img>
 * (image-orientation: from-image je predvolené), takže fotka nebude otočená.
 */
const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
  img.src = url;
});

export const downscaleImage = async (file, { maxSide = 512, quality = 0.85 } = {}) => {
  try {
    if (!file || !/^image\//.test(file.type) || file.type === 'image/gif') return file;
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return file;
    const img = await loadImage(file);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return file;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNG/WebP môžu mať priehľadnosť — JPEG ju nemá a priehľadné plochy by
    // zčerneli (logo firmy ako avatar). Tie preto ostávajú PNG.
    const keepAlpha = file.type === 'image/png' || file.type === 'image/webp';
    const outType = keepAlpha ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, keepAlpha ? undefined : quality));
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;
    const base = (file.name || 'avatar').replace(/\.[^.]+$/, '') || 'avatar';
    return new File([blob], `${base}.${keepAlpha ? 'png' : 'jpg'}`, { type: outType });
  } catch {
    return file;
  }
};
