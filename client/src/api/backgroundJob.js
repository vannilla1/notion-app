import api from './api';

// Dlhá operácia (Google Calendar/Tasks /sync, až ~10 min) beží na serveri
// na pozadí: POST s `?async=1` vráti hneď 202 { jobId } a stav sa zisťuje
// cez GET /api/jobs/:id. Dlhé HTTP spojenie predtým prerušilo mobilné
// WebView / proxy a používateľ videl chybu, hoci sync na serveri prebehol.
//
// Vracia { status, data } ako axios odpoveď synchrónneho endpointu; pri
// chybe hádže error s `response.{status,data}` (catch bloky ostávajú rovnaké).
// Starší server bez podpory async odpovie rovno 200 — vrátime tú odpoveď.
const POLL_MS = 3000;

export const runBackgroundJob = async (url, body = {}, { headers, maxWaitMs = 15 * 60 * 1000 } = {}) => {
  const sep = url.includes('?') ? '&' : '?';
  const start = await api.post(`${url}${sep}async=1`, body, { headers, timeout: 60000 });
  if (start.status !== 202 || !start.data?.jobId) return start;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let job;
    try {
      job = (await api.get(`/api/jobs/${start.data.jobId}`, { timeout: 20000 })).data;
    } catch (err) {
      if (err.response?.status === 404) throw err; // job vypršal / nepatrí nám
      continue; // prechodná chyba siete — skúsime znova
    }
    if (job.status === 'running') continue;
    if (job.httpStatus >= 400) {
      const err = new Error(job.body?.message || 'Operácia zlyhala');
      err.response = { status: job.httpStatus, data: job.body || {} };
      throw err;
    }
    return { status: job.httpStatus || 200, data: job.body || {} };
  }
  const timeoutErr = new Error('timeout');
  timeoutErr.code = 'ECONNABORTED';
  throw timeoutErr;
};
