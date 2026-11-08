// Resumable downloads for large files (models, yt-dlp).
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const http = require("http");

const IDLE_TIMEOUT = 60000;

function request(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http:") ? http : https;
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      resolve(res);
    });
    // Socket idle timeout also covers a stalled body.
    req.setTimeout(IDLE_TIMEOUT, () => req.destroy(new Error("网络长时间没有响应，已暂停下载")));
    req.on("error", reject);
  });
}

/**
 * Download `url` to `destination`. A partial file (`.download`) is kept on failure,
 * and the next call continues from where it stopped (HTTP Range).
 * onProgress receives whole percents, only when the number changes.
 */
async function downloadFile(url, destination, onProgress = () => {}) {
  const partial = `${destination}.download`;
  let start = 0;
  try { start = (await fsp.stat(partial)).size; } catch { start = 0; }
  const headers = { "User-Agent": "ES-Escucha/2" };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await request(url, headers);

  if (res.statusCode === 416 && start > 0) { // the partial file is already complete
    res.resume();
    await fsp.rename(partial, destination);
    onProgress(100);
    return;
  }
  if (![200, 206].includes(res.statusCode)) {
    res.resume();
    throw new Error(`下载失败：HTTP ${res.statusCode}`);
  }
  const resumed = res.statusCode === 206 && start > 0;
  if (!resumed) start = 0;
  let total = Number(res.headers["content-length"] || 0);
  const range = String(res.headers["content-range"] || "").match(/\/(\d+)$/);
  if (resumed && range) total = Number(range[1]); else if (resumed) total += start;

  let received = start, last = -1;
  const report = () => {
    if (!total) return;
    const pct = Math.min(100, Math.floor((received / total) * 100));
    if (pct !== last) { last = pct; onProgress(pct); }
  };
  report();
  await new Promise((resolve, rejectRaw) => {
    const out = fs.createWriteStream(partial, { flags: resumed ? "a" : "w" });
    const reject = (error) => { res.unpipe(out); out.end(() => rejectRaw(error)); };
    res.on("data", (chunk) => { received += chunk.length; report(); });
    res.on("error", reject);
    res.on("aborted", () => reject(new Error("下载被中断，再试一次会从断点继续")));
    out.on("error", rejectRaw);
    out.on("finish", resolve);
    res.pipe(out);
  });
  const size = (await fsp.stat(partial)).size;
  if (total && size < total) throw new Error("下载不完整，再试一次会从断点继续");
  await fsp.rm(destination, { force: true });
  await fsp.rename(partial, destination);
}

module.exports = { downloadFile };
