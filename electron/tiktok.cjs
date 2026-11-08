// TikTok reading / playback / download. Ported unchanged from ES Escucha 1 (only wiring changed):
// this part talks to TikTok's live site and is the most fragile, so its logic was deliberately not rewritten.
const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const http = require("http");
const path = require("path");
const { pathToFileURL } = require("url");
const { dataDir } = require("./paths.cjs");
const { sleep, withTimeout, diagnostic, onlineError } = require("./common.cjs");
const { recognitionJobs, recognitionJob, ensureRecognitionActive, sendRecognitionProgress } = require("./jobs.cjs");

const playbackStreams = new Map();
let playbackServer = null;
let playbackPort = 0;

function sanitizedHeaders(requestHeaders = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!key.startsWith(":") && !/^(host|content-length|connection|range)$/i.test(key) && value != null) headers[key] = String(value);
  }
  headers["Accept-Encoding"] = "identity";
  return headers;
}

async function chromiumSessionDownload(win, url, destination, requestHeaders = {}, onProgress = () => {}) {
  const partial = `${destination}.download`;
  await fsp.rm(partial, { force: true });
  const downloadSession = win.webContents.session;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      downloadSession.removeListener("will-download", onDownload);
      if (error) { await fsp.rm(partial, { force: true }).catch(() => {}); reject(error); return; }
      try { await fsp.rm(destination, { force: true }); await fsp.rename(partial, destination); resolve(); }
      catch (renameError) { reject(renameError); }
    };
    const onDownload = (_event, item, source) => {
      if (source?.id !== win.webContents.id) return;
      item.setSavePath(partial);
      item.on("updated", () => { const total = item.getTotalBytes(), received = item.getReceivedBytes(); if (total > 0) onProgress(Math.min(100, Math.round(received / total * 100))); });
      item.once("done", (_doneEvent, state) => void finish(state === "completed" ? null : new Error(`NETWORK_ERROR|Chromium 下载未完成 (${state})`)));
    };
    const timer = setTimeout(() => void finish(new Error("NETWORK_ERROR|Chromium 下载超时")), 90000);
    downloadSession.on("will-download", onDownload);
    const headers = Object.fromEntries(Object.entries(sanitizedHeaders(requestHeaders)).filter(([key]) => !/^cookie$/i.test(key)));
    try { win.webContents.downloadURL(url, { headers }); }
    catch (error) { void finish(error); }
  });
}

async function requestMediaChunk(downloadSession, url, requestHeaders, start, redirects = 0) {
  const cookies = await downloadSession.cookies.get({ url }).catch(() => []);
  const headers = sanitizedHeaders(requestHeaders);
  if (!Object.keys(headers).some((key) => /^cookie$/i.test(key)) && cookies.length) headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  headers.Range = `bytes=${start}-${start + 4 * 1024 * 1024 - 1}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 8) {
        response.resume();
        return resolve(requestMediaChunk(downloadSession, new URL(response.headers.location, url).toString(), requestHeaders, start, redirects + 1));
      }
      if (response.statusCode === 416 && start > 0) { response.resume(); return resolve({ done: true, buffer: Buffer.alloc(0), next: start }); }
      if (![200, 206].includes(response.statusCode)) { response.resume(); return reject(new Error(`NETWORK_ERROR|TikTok 拒绝下载请求 (${response.statusCode})`)); }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const range = String(response.headers["content-range"] || "").match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
        if (response.statusCode === 200) return resolve({ done: true, buffer, next: buffer.length });
        if (!range || !buffer.length) return reject(new Error("NETWORK_ERROR|TikTok 返回了无效的视频分段"));
        const end = Number(range[2]), total = range[3] === "*" ? 0 : Number(range[3]);
        resolve({ done: total > 0 && end + 1 >= total, buffer, next: end + 1, total });
      });
    }).on("error", reject);
  });
}

async function cookieAwareSegmentDownload(win, url, destination, requestHeaders = {}, onProgress = () => {}) {
  const partial = `${destination}.download`;
  await fsp.rm(partial, { force: true });
  let start = 0;
  try {
    for (let part = 0; part < 256; part++) {
      const result = await requestMediaChunk(win.webContents.session, url, requestHeaders, start);
      await fsp.appendFile(partial, result.buffer);
      if (result.total > 0) onProgress(Math.min(100, Math.round(result.next / result.total * 100)));
      if (result.done) { await fsp.rm(destination, { force: true }); await fsp.rename(partial, destination); return; }
      if (result.next <= start) throw new Error("NETWORK_ERROR|TikTok 视频分段没有继续加载");
      start = result.next;
    }
    throw new Error("NETWORK_ERROR|TikTok 视频分段数量异常");
  } catch (error) { await fsp.rm(partial, { force: true }).catch(() => {}); throw error; }
}

async function validateMediaFile(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size < 65536) throw new Error("NETWORK_ERROR|TikTok 返回的本地文件不完整");
  const handle = await fsp.open(filePath, "r");
  try { const header = Buffer.alloc(64); await handle.read(header, 0, header.length, 0); if (!header.includes(Buffer.from("ftyp")) && !header.includes(Buffer.from("webm"))) throw new Error("NETWORK_ERROR|下载内容不是有效视频文件"); }
  finally { await handle.close(); }
}

async function tiktokCookies() { return session.defaultSession.cookies.get({ domain: ".tiktok.com" }); }
async function hasTikTokLogin() { const cookies = await tiktokCookies(); return cookies.some((cookie) => ["sessionid", "sessionid_ss", "sid_tt", "sid_guard"].includes(cookie.name) && cookie.value); }
function browserWindow(show = false) { const win = new BrowserWindow({ width: 1280, height: 800, x: show ? undefined : -10000, y: 0, show: true, skipTaskbar: !show, title: "TikTok — ES Escucha", autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } }); win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ Electron\/[^ ]+/, "").replace(/ ES-Escucha\/[^ ]+/, "")); if (!show) win.webContents.setAudioMuted(true); return win; }
function imageUrl(value) { if (!value) return ""; if (typeof value === "string") return value; return value.urlList?.[0] || value.url_list?.[0] || value.url || ""; }
function tikTokMediaUrls(video = {}) {
  const urls = [];
  const add = (value) => { for (const url of typeof value === "string" ? [value] : value?.UrlList || value?.urlList || value?.url_list || []) if (typeof url === "string" && url.startsWith("https://")) urls.push(url); };
  // Only media fields inside the exact item, never page-wide video requests.
  add(video.playAddr || video.play_addr);
  add(video.PlayAddrStruct);
  for (const variant of video.bitrateInfo || []) if (/h264|avc/i.test(variant.CodecType || "")) add(variant.PlayAddr);
  return [...new Set(urls)];
}
function targetMediaChoices(itemId, collected, candidates) {
  const target = collected.get(String(itemId));
  if (!target || target.id !== String(itemId)) return [];
  return (target.mediaUrls || []).map((url) => ({ url, headers: candidates.find((candidate) => candidate.url === url)?.headers || {}, duration: target.duration }));
}
function matchesMediaDuration(actual, expected) {
  return Number.isFinite(actual) && actual > 0 && (!expected || Math.abs(actual - expected) <= Math.max(1, expected * .05));
}
function extractTikTokItems(value, output = new Map(), budget = { count: 0 }) {
  if (!value || typeof value !== "object" || budget.count++ > 60000) return output;
  const id = String(value.id || value.itemId || value.item_id || value.aweme_id || ""); const authorValue = value.author || value.authorInfo || value.author_info; const author = typeof authorValue === "string" ? authorValue : authorValue?.uniqueId || authorValue?.unique_id || value.authorId;
  if (/^\d{12,}$/.test(id) && (value.video || value.desc || value.aweme_id)) { const url = author ? `https://www.tiktok.com/@${author}/video/${id}` : `https://www.tiktok.com/video/${id}`; const previous = output.get(id) || {}, mediaUrls = tikTokMediaUrls(value.video); output.set(id, { ...previous, id, url, title: value.desc || value.description || value.title || "TikTok 视频", thumbnail: imageUrl(value.video?.cover || value.video?.originCover || value.video?.dynamicCover || value.cover), duration: Number(value.video?.duration || value.duration || 0) / (Number(value.video?.duration || 0) > 10000 ? 1000 : 1), author: author || "", mediaUrls: mediaUrls.length ? mediaUrls : previous.mediaUrls || [] }); }
  if (Array.isArray(value)) for (const item of value) extractTikTokItems(item, output, budget); else for (const child of Object.values(value)) extractTikTokItems(child, output, budget); return output;
}
async function pageState(win) { return withTimeout(win.webContents.executeJavaScript(`(() => {const roots=[document],links=[];for(let i=0;i<roots.length;i++){const root=roots[i];for(const el of root.querySelectorAll('*')){if(el.shadowRoot)roots.push(el.shadowRoot);const href=el.href||el.getAttribute?.('href');if(href&&/\\/@[^/]+\\/video\\/\\d+/.test(href))links.push({url:new URL(href,location.href).href,title:(el.getAttribute?.('aria-label')||el.innerText||el.querySelector?.('img')?.alt||'').trim(),thumbnail:el.querySelector?.('img')?.src||''});}}const embedded=[...document.scripts].filter(s=>s.id==='__UNIVERSAL_DATA_FOR_REHYDRATION__'||s.type==='application/json').map(s=>s.textContent||'').filter(Boolean).slice(0,12);return{url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,2500),videos:links,authors:[...new Set([...document.querySelectorAll('a[href*="/@"]')].map(a=>a.href).filter(h=>/tiktok.com\\/@[^/]+\\/?$/.test(h)))],embedded};})()`), 7000, "读取 TikTok 页面"); }
function collectState(state, collected, counts) { for (const item of state.videos || []) { const id = item.url.match(/\/video\/(\d+)/)?.[1]; if (id && !collected.has(id)) collected.set(id, { id, ...item }); } counts.dom = collected.size; for (const text of state.embedded || []) { try { const before = collected.size; extractTikTokItems(JSON.parse(text), collected); counts.embedded += collected.size - before; } catch {} } }
async function attachTikTokNetwork(win, collected, media, counts) {
  const requests = new Map(), jsonRequests = new Set();
  win.webContents.debugger.attach("1.3");
  win.webContents.debugger.on("message", async (_event, method, params) => {
    const id = params.requestId;
    if (method === "Network.requestWillBeSent") { requests.set(id, { ...(requests.get(id) || {}), ...(params.request?.headers || {}) }); return; }
    if (method === "Network.requestWillBeSentExtraInfo") {
      const cookie = (params.associatedCookies || []).filter((entry) => !entry.blockedReasons?.length && entry.cookie?.name).map((entry) => `${entry.cookie.name}=${entry.cookie.value}`).join("; ");
      requests.set(id, { ...(requests.get(id) || {}), ...(params.headers || {}), ...(cookie ? { Cookie: cookie } : {}) }); return;
    }
    if (method === "Network.responseReceived") {
      const response = params.response || {};
      if (response.status >= 200 && response.status < 300 && (String(response.mimeType).startsWith("video/") || /mime_type=video|\.mp4(?:\?|$)/i.test(response.url || ""))) media.push({ url: response.url, headers: requests.get(id) || response.requestHeaders || {} });
      if (/json/i.test(response.mimeType || "") && /^https:\/\/([^/]+\.)?tiktok\.com\//i.test(response.url || "")) jsonRequests.add(id);
      return;
    }
    if (method === "Network.loadingFailed") { jsonRequests.delete(id); requests.delete(id); return; }
    if (method !== "Network.loadingFinished") return;
    if (jsonRequests.delete(id)) {
      try {
        const body = await win.webContents.debugger.sendCommand("Network.getResponseBody", { requestId: id });
        const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        const before = collected.size; extractTikTokItems(JSON.parse(text), collected); counts.network += collected.size - before;
      } catch {}
    }
    requests.delete(id);
  });
  await win.webContents.debugger.sendCommand("Network.enable");
}
// Only a real security check (slider / captcha) or a full redirect to the login page blocks reading.
// Logged-out TikTok pages almost always show a "登录 TikTok" prompt, but the video still loads,
// so that prompt alone must NOT pop the window up (v1 did, and hid it again as soon as the prompt changed).
function needsVerification(state, media = []) {
  if (media.length) return false; // video data already captured: nothing to wait for
  const captcha = /captcha|verify/i.test(state.url) || /verify to continue|security verification|drag the slider|拖动滑块|验证以继续|完成验证/i.test(state.text);
  const loginWall = /tiktok\.com\/login/i.test(state.url);
  return captcha || loginWall;
}
async function loadTikTokPage(event, inputUrl) {
  event.sender.send("online:status", "正在启动 TikTok 读取器…"); const win = browserWindow(false), collected = new Map(), media = [], counts = { dom: 0, embedded: 0, network: 0 }, navigations = []; let closed = false; win.on("closed", () => { closed = true; }); win.webContents.on("will-redirect", (_event, url) => navigations.push(url)); win.webContents.on("did-navigate", (_event, url) => navigations.push(url)); await win.loadURL("about:blank"); await withTimeout(attachTikTokNetwork(win, collected, media, counts), 5000, "启动网络监听").catch(async (error) => { counts.network = -1; await diagnostic("TikTok optional network monitor", error); });
  try {
    event.sender.send("online:status", "打开 TikTok 页面…"); await withTimeout(win.loadURL(inputUrl), 25000, "打开 TikTok 页面").catch(async (error) => { await diagnostic("TikTok load timeout", error); }); await sleep(3500); let state = await pageState(win); collectState(state, collected, counts);
    if (needsVerification(state, media)) { event.sender.send("online:status", "TikTok 要求安全验证：请在弹出的窗口里完成验证…"); win.setSkipTaskbar(false); win.center(); win.show(); for (let i = 0; i < 240 && !closed; i++) { await sleep(1000); state = await pageState(win).catch(() => state); if (!needsVerification(state, media)) { win.setSkipTaskbar(true); win.setPosition(-10000, 0); break; } } if (closed || needsVerification(state, media)) throw new Error("LOGIN_REQUIRED|TikTok 验证尚未完成，请重新登录后再试。"); }
    const canonicalUrl = navigations.find((url) => /tiktok\.com\/@[^/]+\/video\/\d+/i.test(url)) || navigations.find((url) => /tiktok\.com\/@[^/?]+/i.test(url)) || state.url; return { win, state, collected, media, counts, canonicalUrl };
  } catch (error) { if (!closed) win.close(); throw error?.message?.includes("|") ? error : onlineError(error); }
}
async function verifiedTikTokMedia(page, item) {
  const { win, collected, media, counts } = page;
  win.webContents.setAudioMuted(true);
  let choices = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    collectState(await pageState(win), collected, counts);
    choices = targetMediaChoices(item.id, collected, media);
    if (choices.length) break;
    await sleep(500);
  }
  for (const candidate of choices.slice(0, 4)) {
    const duration = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const video = document.createElement('video'); video.muted = true; video.preload = 'metadata';
      const finish = value => { clearTimeout(timer); video.onloadedmetadata = video.onerror = null; video.removeAttribute('src'); video.load(); resolve(value); };
      const timer = setTimeout(() => finish(0), 7000);
      video.onloadedmetadata = () => finish(video.duration); video.onerror = () => finish(0);
      video.src = ${JSON.stringify(candidate.url)};
    })`).catch(() => 0);
    if (matchesMediaDuration(duration, candidate.duration)) {
      await diagnostic("TikTok verified media", JSON.stringify({ videoId: item.id, expectedDuration: candidate.duration, actualDuration: duration, candidates: media.length, verifiedChoices: choices.length, host: new URL(candidate.url).hostname }));
      return { ...candidate, duration };
    }
  }
  await diagnostic("TikTok target media rejected", JSON.stringify({ videoId: item.id, candidates: media.length, verifiedChoices: choices.length }));
  throw new Error("PAGE_CHANGED|未取得这条视频的有效正文，已排除片头动画和其他视频。请稍后重试。");
}
async function captureTikTokPlayback(event, item) {
  const page = await loadTikTokPage(event, item.url), { win } = page;
  try {
    const candidate = await verifiedTikTokMedia(page, item);
    const cookies = await session.defaultSession.cookies.get({ url: candidate.url });
    const cookie = cookies.map((value) => `${value.name}=${value.value}`).join("; ");
    return { url: candidate.url, duration: candidate.duration, headers: { ...candidate.headers, Referer: item.url, "User-Agent": win.webContents.getUserAgent(), ...(cookie ? { Cookie: cookie } : {}) } };
  } finally {
    if (!win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    if (!win.isDestroyed()) win.close();
  }
}
function safeProxyHeaders(source, range) {
  const headers = {};
  for (const [key, value] of Object.entries(source || {})) if (!key.startsWith(":") && !/^(host|content-length|connection|accept-encoding)$/i.test(key) && value != null) headers[key] = String(value);
  if (range) headers.Range = range;
  headers["Accept-Encoding"] = "identity";
  return headers;
}
async function forwardPlayback(req, res, entry, mayRefresh = true) {
  return new Promise((resolve) => {
    const upstream = https.request(entry.url, { method: req.method === "HEAD" ? "HEAD" : "GET", headers: safeProxyHeaders(entry.headers, req.headers.range) }, (response) => {
      if ([401, 403].includes(response.statusCode) && mayRefresh) {
        response.resume();
        response.on("end", async () => { try { const fresh = await captureTikTokPlayback({ sender: entry.sender }, entry.item); entry.url = fresh.url; entry.headers = fresh.headers; entry.refreshes++; await forwardPlayback(req, res, entry, false); } catch (error) { if (!res.headersSent) { res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); res.end("TikTok 媒体地址刷新失败"); } } resolve(); });
        return;
      }
      const allowed = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"];
      const headers = {}; for (const name of allowed) if (response.headers[name] != null) headers[name] = response.headers[name];
      headers["Access-Control-Allow-Origin"] = "*"; res.writeHead(response.statusCode || 502, headers); response.pipe(res); response.on("end", resolve); response.on("error", () => { if (!res.destroyed) res.destroy(); resolve(); });
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); if (!res.writableEnded) res.end("TikTok 媒体连接失败"); resolve(); });
    req.on("aborted", () => upstream.destroy()); upstream.end();
  });
}
async function ensurePlaybackServer() {
  if (playbackServer) return playbackPort;
  playbackServer = http.createServer(async (req, res) => {
    const match = String(req.url || "").match(/^\/media\/([a-f0-9]{48})(?:\?|$)/i), entry = match && playbackStreams.get(match[1]);
    if (!entry || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end(); return; }
    await forwardPlayback(req, res, entry);
  });
  await new Promise((resolve, reject) => { playbackServer.once("error", reject); playbackServer.listen(0, "127.0.0.1", () => { playbackServer.removeListener("error", reject); resolve(); }); });
  playbackPort = playbackServer.address().port; return playbackPort;
}
function releasePlayback(videoId) { for (const [token, entry] of playbackStreams) if (!videoId || entry.item.id === videoId) playbackStreams.delete(token); }
async function downloadTikTokVideo(event, item, jobId, mediaKey) {
  const folder = path.join(dataDir(), "media"); await fsp.mkdir(folder, { recursive: true }); const filePath = path.join(folder, `tiktok-${item.id}.mp4`); let lastError;
  for (let refresh = 0; refresh < 2; refresh++) {
    ensureRecognitionActive(jobId); sendRecognitionProgress(event, jobId, mediaKey, { stage: "download", percent: 3, message: "正在取得 TikTok 媒体地址" });
    event.sender.send("online:status", refresh ? "媒体地址已过期，正在刷新一次…" : "正在取得 TikTok 媒体地址…");
    const page = await loadTikTokPage(event, item.url), { win } = page; recognitionJob(jobId, mediaKey).window = win; ensureRecognitionActive(jobId);
    try {
      const choices = [await verifiedTikTokMedia(page, item)];
      for (const candidate of choices) {
        const headers = { ...candidate.headers, Referer: item.url, "User-Agent": win.webContents.getUserAgent() };
        event.sender.send("online:status", "正在下载识别文件…");
        try { await chromiumSessionDownload(win, candidate.url, filePath, headers, (percent) => sendRecognitionProgress(event, jobId, mediaKey, { stage: "download", percent: 8 + Math.round(percent * .27), message: `正在下载识别文件 ${percent}%` })); ensureRecognitionActive(jobId); await validateMediaFile(filePath); event.sender.send("online:status", "本地识别文件已就绪"); return { path: filePath, url: pathToFileURL(filePath).toString(), name: item.title }; }
        catch (chromiumError) {
          await diagnostic("TikTok Chromium download fallback", chromiumError);
          await fsp.rm(filePath, { force: true }).catch(() => {});
          try { await cookieAwareSegmentDownload(win, candidate.url, filePath, headers, (percent) => sendRecognitionProgress(event, jobId, mediaKey, { stage: "download", percent: 8 + Math.round(percent * .27), message: `正在分段下载识别文件 ${percent}%` })); ensureRecognitionActive(jobId); await validateMediaFile(filePath); event.sender.send("online:status", "本地识别文件已就绪"); return { path: filePath, url: pathToFileURL(filePath).toString(), name: item.title }; }
          catch (fallbackError) { lastError = fallbackError; await fsp.rm(filePath, { force: true }).catch(() => {}); }
        }
      }
    } catch (error) { lastError = error; }
    finally { const job = recognitionJobs.get(jobId); if (job?.window === win) job.window = null; if (!win.isDestroyed() && win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); if (!win.isDestroyed()) win.close(); }
  }
  throw lastError || new Error("NETWORK_ERROR|离线文件准备失败，请重新登录 TikTok 后重试。");
}

function shutdownPlayback() { releasePlayback(); if (playbackServer) playbackServer.close(); playbackServer = null; }
function playbackUrl(token, refresh) { return `http://127.0.0.1:${playbackPort}/media/${token}${refresh ? `?refresh=${Date.now()}` : ""}`; }

module.exports = {
  playbackStreams, browserWindow, tiktokCookies, hasTikTokLogin, captureTikTokPlayback, ensurePlaybackServer,
  releasePlayback, downloadTikTokVideo, shutdownPlayback, playbackUrl,
};
