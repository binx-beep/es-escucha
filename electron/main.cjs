// ES Escucha 2 — Electron main process.
const { app, BrowserWindow, dialog, ipcMain, shell, session, protocol, net } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");

app.setName("ES Escucha 2");
// Look like plain Chrome to websites (TikTok/YouTube): drop the "Electron/x" and "ES Escucha 2/x" tokens everywhere.
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/\S+/, "")
  .split(` ${app.getName()}/${app.getVersion()}`).join("")
  .replace(/ es-escucha-2\/\S+/i, "");
const paths = require("./paths.cjs");
let storageError = null;
try {
  const root = paths.resolveRoot();
  app.setPath("userData", path.join(root, "user-data"));
  app.setPath("sessionData", path.join(root, "browser-cache"));
} catch (error) { storageError = error; }

const { dataDir, sub, LEGACY_ROOT } = paths;
const { downloadFile } = require("./net.cjs");
const { diagnostic, onlineError, runTool } = require("./common.cjs");
const jobs = require("./jobs.cjs");
const whisper = require("./whisper.cjs");
const tiktok = require("./tiktok.cjs");

// A private scheme lets the UI fetch() local media without copying the whole file through IPC.
protocol.registerSchemesAsPrivileged([{ scheme: "escucha-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }]);
const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|m4a|mp3|wav|aac|ogg|oga|opus|flac)$/i;

// ---------- settings ----------
const DEFAULT_SETTINGS = { cleanupPolicy: "immediate", speed: "fast", threads: "auto", vad: false };
async function readConfig() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(await fsp.readFile(path.join(dataDir(), "settings.json"), "utf8")) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function sanitizeSettings(value) {
  const out = {};
  if (["immediate", "7days", "2gb", "never"].includes(value?.cleanupPolicy)) out.cleanupPolicy = value.cleanupPolicy;
  if (["fast", "accurate"].includes(value?.speed)) out.speed = value.speed;
  if (value?.threads === "auto" || (Number.isInteger(value?.threads) && value.threads > 0 && value.threads <= 256)) out.threads = value.threads;
  if (typeof value?.vad === "boolean") out.vad = value.vad;
  return out;
}
async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...sanitizeSettings(patch) };
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.writeFile(path.join(dataDir(), "settings.json"), JSON.stringify(next, null, 2));
  return next;
}

// ---------- disk helpers ----------
async function directorySize(folder) {
  let total = 0;
  for (const entry of await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(folder, entry.name);
    total += entry.isDirectory() ? await directorySize(target) : (await fsp.stat(target).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
async function clearDirectory(folder) {
  await fsp.mkdir(folder, { recursive: true });
  for (const entry of await fsp.readdir(folder)) await fsp.rm(path.join(folder, entry), { recursive: true, force: true }).catch(() => {});
}
async function cacheFiles(folder) {
  const result = [];
  for (const entry of await fsp.readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await cacheFiles(target));
    else { const stat = await fsp.stat(target).catch(() => null); if (stat) result.push({ path: target, size: stat.size, time: stat.mtimeMs }); }
  }
  return result;
}
const isInside = (file, folder) => {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};
async function runCleanup(policy, { startup = false } = {}) {
  if (policy === "never") return;
  if (policy === "immediate") { if (startup) { await clearDirectory(sub("temp")); await clearDirectory(sub("media")); } return; }
  const files = [...await cacheFiles(sub("temp")), ...await cacheFiles(sub("media"))];
  if (policy === "7days") { const cutoff = Date.now() - 7 * 86400000; for (const f of files) if (f.time < cutoff) await fsp.rm(f.path, { force: true }).catch(() => {}); }
  if (policy === "2gb") {
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files.sort((a, b) => a.time - b.time)) { if (total <= 2 * 1024 ** 3) break; await fsp.rm(f.path, { force: true }).catch(() => {}); total -= f.size; }
  }
}

// ---------- yt-dlp ----------
const ytDlpPath = () => path.join(sub("tools"), "yt-dlp.exe");
async function ensureYtDlp(event) {
  const target = ytDlpPath();
  if (fs.existsSync(target)) return target;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const legacy = path.join(LEGACY_ROOT, "data", "tools", "yt-dlp.exe");
  if (fs.existsSync(legacy)) { await fsp.copyFile(legacy, target); return target; }
  event?.sender.send("online:status", "首次使用：正在下载在线视频解析器…");
  await downloadFile("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", target, (p) => event?.sender.send("online:status", `正在下载解析器 ${p}%`));
  return target;
}
let lastYtDlpUpdate = 0;
async function updateYtDlp(event) {
  const exe = await ensureYtDlp(event);
  event?.sender.send("online:status", "正在更新解析器 yt-dlp…");
  const out = await runTool(exe, ["-U"]);
  lastYtDlpUpdate = Date.now();
  return out.split(/\r?\n/).filter(Boolean).at(-1) || "已是最新版本";
}
/** Run yt-dlp; on failure update it once (YouTube changes often) and retry. */
async function ytDlp(event, args, onLine, job) {
  const exe = await ensureYtDlp(event);
  try { return await runTool(exe, args, onLine, job); }
  catch (error) {
    if (job?.cancelled || Date.now() - lastYtDlpUpdate < 10 * 60000) throw onlineError(error);
    await diagnostic("yt-dlp failed, updating", error);
    try { await updateYtDlp(event); } catch (updateError) { await diagnostic("yt-dlp update", updateError); throw onlineError(error); }
    try { return await runTool(exe, args, onLine, job); } catch (retryError) { throw onlineError(retryError); }
  }
}

// ---------- IPC: files & media ----------
const mediaResult = (filePath, name) => ({ path: filePath, url: pathToFileURL(filePath).toString(), name: name || path.basename(filePath) });

ipcMain.handle("media:pick", async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    properties: ["openFile"],
    filters: [{ name: "视频或音频", extensions: ["mp4", "m4v", "mov", "mkv", "webm", "m4a", "mp3", "wav", "aac", "ogg", "opus", "flac"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return mediaResult(result.filePaths[0]);
});
// Fallback reader (the UI normally streams via the escucha-file:// scheme). Only media files are readable.
ipcMain.handle("media:read", async (_event, filePath) => {
  if (typeof filePath !== "string" || !MEDIA_EXT.test(filePath)) throw new Error("不支持的文件类型");
  return fsp.readFile(filePath);
});
ipcMain.handle("media:list-downloaded", async () => {
  const folder = sub("media"); await fsp.mkdir(folder, { recursive: true });
  const files = [];
  for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".download") || entry.name.endsWith(".part")) continue;
    const stat = await fsp.stat(path.join(folder, entry.name)).catch(() => null);
    if (stat) files.push({ name: entry.name, size: stat.size, modified: stat.mtimeMs });
  }
  return files.sort((a, b) => b.modified - a.modified);
});
ipcMain.handle("media:open-folder", async () => {
  const folder = sub("media"); await fsp.mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder); if (error) throw new Error(error); return true;
});
ipcMain.handle("media:delete-downloaded", async (_event, names) => {
  const folder = path.resolve(sub("media")), deleted = [];
  for (const value of Array.isArray(names) ? names : []) {
    const name = String(value);
    if (path.basename(name) !== name) continue;
    const target = path.resolve(folder, name);
    if (path.dirname(target) !== folder) continue;
    if (fs.existsSync(target) && (await fsp.stat(target)).isFile()) { await fsp.rm(target, { force: true }); deleted.push(target); }
  }
  return deleted;
});
ipcMain.handle("audio:save", async (_event, arrayBuffer) => {
  await fsp.mkdir(sub("temp"), { recursive: true });
  const file = path.join(sub("temp"), `audio-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.wav`);
  await fsp.writeFile(file, Buffer.from(arrayBuffer)); return file;
});
ipcMain.handle("export:text", async (event, { name, content }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: path.join(app.getPath("documents"), String(name || "export.csv").replace(/[\\/:*?"<>|]/g, "_")),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, String(content), "utf8");
  return result.filePath;
});

// ---------- IPC: models ----------
ipcMain.handle("model:status", async () => {
  const result = {}; for (const id of Object.keys(whisper.MODELS)) result[id] = fs.existsSync(whisper.modelPath(id)); return result;
});
const modelDownloads = new Map();
ipcMain.handle("model:download", async (event, id) => {
  if (!whisper.MODELS[id]) throw new Error("未知模型");
  if (modelDownloads.has(id)) return modelDownloads.get(id);
  const destination = whisper.ownModelPath(id);
  const task = (async () => {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await downloadFile(whisper.MODELS[id].url, destination, (percent) => { if (!event.sender.isDestroyed()) event.sender.send("model:progress", { id, percent }); });
    return true;
  })().finally(() => modelDownloads.delete(id));
  modelDownloads.set(id, task);
  return task;
});
ipcMain.handle("model:delete", async (_event, id) => {
  if (!whisper.MODELS[id]) throw new Error("未知模型");
  await fsp.rm(whisper.ownModelPath(id), { force: true });
  await fsp.rm(`${whisper.ownModelPath(id)}.download`, { force: true });
  return true;
});
ipcMain.handle("model:download-vad", async (event) => {
  await fsp.mkdir(sub("models"), { recursive: true });
  await downloadFile(whisper.VAD_MODEL.url, whisper.vadModelPath(), (percent) => { if (!event.sender.isDestroyed()) event.sender.send("model:progress", { id: "vad", percent }); });
  return true;
});

// ---------- IPC: settings & storage ----------
ipcMain.handle("cache:stats", async () => ({
  temp: await directorySize(sub("temp")), media: await directorySize(sub("media")), models: await directorySize(sub("models")),
  records: await directorySize(path.join(paths.root(), "user-data", "Local Storage")),
  settings: await readConfig(), root: paths.root(), cpuCount: whisper.cpuCount(), autoThreads: whisper.autoThreads(),
  vadModel: fs.existsSync(whisper.vadModelPath()), legacyModels: whisper.usesLegacyModel(),
}));
ipcMain.handle("cache:clear", async (_event, kind) => {
  if (kind === "temp") await clearDirectory(sub("temp"));
  else if (kind === "media") await clearDirectory(sub("media"));
  else throw new Error("不允许清除此目录");
  return true;
});
ipcMain.handle("settings:save", async (_event, patch) => {
  const next = await writeConfig(patch);
  if (patch && "cleanupPolicy" in patch) void runCleanup(next.cleanupPolicy).catch((e) => diagnostic("cleanup", e));
  return next;
});
ipcMain.handle("storage:choose", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, { title: "选择新的数据目录", properties: ["openDirectory", "createDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const root = pick.filePaths[0];
  const confirm = await dialog.showMessageBox(win, {
    type: "question", buttons: ["切换并重启", "取消"], defaultId: 0, cancelId: 1,
    message: `数据目录改为：\n${root}`,
    detail: "软件会重启。旧目录里的模型、学习记录不会自动搬过去；需要的话可以先手动把旧目录的内容复制到新目录。",
  });
  if (confirm.response !== 0) return null;
  paths.setChosenRoot(root);
  app.relaunch(); app.exit(0);
  return root;
});
ipcMain.handle("parser:update", async (event) => updateYtDlp(event));

// ---------- IPC: TikTok ----------
ipcMain.handle("tiktok:login-status", async () => tiktok.hasTikTokLogin());
ipcMain.handle("tiktok:logout", async () => {
  const cookies = await tiktok.tiktokCookies();
  await Promise.all(cookies.map((cookie) => session.defaultSession.cookies.remove(`https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`, cookie.name)));
  await session.defaultSession.clearStorageData({ origins: ["https://www.tiktok.com"], storages: ["localstorage", "indexdb", "serviceworkers"] });
  return false;
});
ipcMain.handle("tiktok:login", async (event) => new Promise((resolve) => {
  const login = new BrowserWindow({
    width: 520, height: 760, title: "登录 TikTok — ES Escucha", icon: path.join(__dirname, "..", "build", "icon.png"), autoHideMenuBar: true,
    parent: BrowserWindow.fromWebContents(event.sender) || undefined, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  login.webContents.setUserAgent(login.webContents.getUserAgent().replace(/ Electron\/[^ ]+/, "").replace(/ ES[- ]Escucha[^ ]*\/[^ ]+/g, ""));
  login.loadURL("https://www.tiktok.com/login");
  // Close by itself as soon as TikTok has set the session cookie (QR or password login).
  const poll = setInterval(async () => {
    if (login.isDestroyed()) return clearInterval(poll);
    if (await tiktok.hasTikTokLogin()) { clearInterval(poll); setTimeout(() => { if (!login.isDestroyed()) login.close(); }, 1200); }
  }, 1500);
  login.on("closed", async () => { clearInterval(poll); resolve(await tiktok.hasTikTokLogin()); });
}));
ipcMain.handle("tiktok:playback-prepare", async (event, item) => {
  if (!item?.id || !String(item.url || "").includes("tiktok.com")) throw new Error("VIDEO_UNAVAILABLE|不是有效的 TikTok 视频。");
  tiktok.releasePlayback(item.id); event.sender.send("online:status", "正在准备 TikTok 视频…");
  const captured = await tiktok.captureTikTokPlayback(event, item), token = crypto.randomBytes(24).toString("hex");
  await tiktok.ensurePlaybackServer();
  tiktok.playbackStreams.set(token, { ...captured, item, sender: event.sender, refreshes: 0 });
  event.sender.send("online:status", "TikTok 视频已准备好");
  return { url: tiktok.playbackUrl(token), token, videoId: item.id };
});
ipcMain.handle("tiktok:playback-refresh", async (event, videoId) => {
  const pair = [...tiktok.playbackStreams].find(([, entry]) => entry.item.id === videoId);
  if (!pair) throw new Error("VIDEO_UNAVAILABLE|播放会话已经失效，请重新点击播放。");
  const [token, entry] = pair;
  if (entry.refreshes >= 1) throw new Error("NETWORK_ERROR|TikTok 拒绝了视频播放，请稍后重试。");
  event.sender.send("online:status", "媒体地址已过期，正在刷新一次…");
  const captured = await tiktok.captureTikTokPlayback(event, entry.item);
  entry.url = captured.url; entry.headers = captured.headers; entry.refreshes++;
  return { url: tiktok.playbackUrl(token, true), token, videoId };
});
ipcMain.handle("tiktok:playback-release", async (_event, videoId) => { tiktok.releasePlayback(String(videoId || "")); return true; });

// ---------- IPC: online videos ----------
ipcMain.handle("online:video", async (event, inputUrl) => {
  const value = String(inputUrl).trim();
  if (/tiktok\.com/i.test(value)) {
    event.sender.send("online:status", "正在解析 TikTok 视频…");
    let finalUrl = value, id = value.match(/\/video\/(\d+)/)?.[1];
    if (!id) {
      const win = tiktok.browserWindow(false), navigations = [];
      try {
        win.webContents.on("will-redirect", (_e, url) => navigations.push(url));
        win.webContents.on("did-navigate", (_e, url) => navigations.push(url));
        await Promise.race([win.loadURL(value), new Promise((r) => setTimeout(r, 20000))]).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        finalUrl = navigations.find((url) => /tiktok\.com\/@[^/]+\/video\/\d+/i.test(url)) || win.webContents.getURL();
        id = finalUrl.match(/\/video\/(\d+)/)?.[1];
      } finally { if (!win.isDestroyed()) win.close(); }
    }
    if (!id) throw new Error("VIDEO_UNAVAILABLE|请粘贴具体的 TikTok 视频链接，而不是频道链接。");
    const author = finalUrl.match(/tiktok\.com\/@([^/]+)/i)?.[1] || "";
    event.sender.send("online:status", "视频已打开，保持暂停");
    return { id, platform: "TikTok", url: finalUrl, title: author ? `@${author} 的 TikTok 视频` : "TikTok 视频", thumbnail: "", duration: 0 };
  }
  if (/youtu\.be|youtube\.com/i.test(value)) {
    const id = value.match(/youtu\.be\/([\w-]{11})/i)?.[1] || value.match(/[?&]v=([\w-]{11})/i)?.[1] || value.match(/\/(?:shorts|live|embed)\/([\w-]{11})/i)?.[1];
    if (!id) throw new Error("VIDEO_UNAVAILABLE|请粘贴具体的 YouTube 视频链接，而不是频道链接。");
    event.sender.send("online:status", "正在读取 YouTube 视频信息…");
    let metadata = {};
    try { metadata = JSON.parse(await ytDlp(event, ["--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", `https://www.youtube.com/watch?v=${id}`])); }
    catch (error) { await diagnostic("YouTube metadata", error); }
    event.sender.send("online:status", "视频已打开，保持暂停");
    return { id, platform: "YouTube", url: `https://www.youtube.com/watch?v=${id}`, title: metadata.title || "YouTube 视频", thumbnail: metadata.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: metadata.duration || 0 };
  }
  throw new Error("VIDEO_UNAVAILABLE|仅支持 TikTok 或 YouTube 的具体视频链接。");
});
ipcMain.handle("recognition:cancel", async (_event, jobId) => jobs.cancelJob(jobId));
ipcMain.handle("online:download", async (event, { item, jobId, mediaKey }) => {
  const job = jobs.recognitionJob(jobId, mediaKey); jobs.ensureRecognitionActive(jobId);
  if (String(item.url).includes("tiktok.com")) {
    try { return await tiktok.downloadTikTokVideo(event, item, jobId, mediaKey); }
    catch (error) { await diagnostic("TikTok download", error); throw error; }
  }
  const folder = sub("media"); await fsp.mkdir(folder, { recursive: true });
  event.sender.send("online:status", "正在下载音频…");
  jobs.sendRecognitionProgress(event, jobId, mediaKey, { stage: "download", percent: 3, message: "正在准备 YouTube 音频" });
  // Recognition only needs the sound: audio-only is a fraction of the video size, so this is much faster.
  const args = ["--no-warnings", "--no-playlist", "--newline", "-f", "bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best",
    "-o", path.join(folder, "%(extractor)s-%(id)s.%(ext)s"), "--print", "after_move:filepath", item.url];
  const result = await ytDlp(event, args, (line) => {
    const match = line.match(/\[download\]\s+([\d.]+)%/);
    if (match) {
      const value = Math.max(0, Math.min(100, Number(match[1])));
      jobs.sendRecognitionProgress(event, jobId, mediaKey, { stage: "download", percent: 8 + Math.round(value * 0.27), message: `正在下载音频 ${Math.round(value)}%` });
    }
  }, job);
  jobs.ensureRecognitionActive(jobId);
  const filePath = result.split(/\r?\n/).filter(Boolean).at(-1);
  if (!filePath || !fs.existsSync(filePath)) throw new Error("音频下载完成，但未找到文件");
  event.sender.send("online:status", "音频已就绪");
  return mediaResult(filePath, item.title);
});

// ---------- IPC: recognition ----------
ipcMain.handle("whisper:transcribe", async (event, { wavPath, modelId, jobId, mediaKey, mediaPath }) => {
  const job = jobs.recognitionJob(jobId, mediaKey); jobs.ensureRecognitionActive(jobId);
  const settings = await readConfig();
  jobs.sendRecognitionProgress(event, jobId, mediaKey, { stage: "recognize", percent: 45, message: "正在生成西班牙语字幕 0%" });
  let jsonPath = null;
  try {
    const out = await whisper.transcribe({
      wavPath, modelId, settings, job,
      onPercent: (value) => jobs.sendRecognitionProgress(event, jobId, mediaKey, { stage: "recognize", percent: 45 + Math.round(value * 0.53), message: `正在生成西班牙语字幕 ${value}%` }),
    });
    jsonPath = out.jsonPath;
    jobs.ensureRecognitionActive(jobId);
    let mediaDeleted = false;
    if (settings.cleanupPolicy === "immediate" && typeof mediaPath === "string" && isInside(mediaPath, sub("media"))) {
      await fsp.rm(mediaPath, { force: true }).catch(() => {});
      mediaDeleted = true;
    }
    jobs.sendRecognitionProgress(event, jobId, mediaKey, { stage: "done", percent: 100, message: `字幕解析完成 · ${out.segments.length} 段` });
    return { segments: out.segments, mediaDeleted };
  } catch (error) {
    if (!job.cancelled) await diagnostic("whisper", error);
    throw error;
  } finally {
    // The WAV and whisper's JSON are only intermediates: always remove them unless the user keeps everything.
    if (settings.cleanupPolicy !== "never") {
      await fsp.rm(wavPath, { force: true }).catch(() => {});
      if (jsonPath) await fsp.rm(jsonPath, { force: true }).catch(() => {});
    }
    jobs.recognitionJobs.delete(jobId);
  }
});

// ---------- window ----------
// webContents id → where keyboard focus is: "none" (not typing), "player" (dictation box), "text" (other text field)
const focusKind = new Map();
ipcMain.on("keys:focus-kind", (event, kind) => { focusKind.set(event.sender.id, ["none", "player", "text"].includes(kind) ? kind : "none"); });
/**
 * Ctrl+← / Ctrl+→ : back / forward 2 s, always (also while typing).
 * ← / →            : same, but only when not typing, so the cursor moves normally in text.
 * ↑ / ↓            : play/pause, replay sentence — when not typing or in the dictation box.
 */
function playerKey(input, kind) {
  if (input.type !== "keyDown" || input.alt || input.meta || input.shift) return null;
  const lr = input.key === "ArrowLeft" || input.key === "ArrowRight", ud = input.key === "ArrowUp" || input.key === "ArrowDown";
  if (input.control) return lr ? input.key : null;
  if (lr) return kind === "none" ? input.key : null;
  if (ud) return kind === "text" ? null : input.key;
  return null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 920, minHeight: 680, show: false, backgroundColor: "#e5e5e2",
    title: "ES Escucha 2", icon: path.join(__dirname, "..", "build", "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ Electron\/[^ ]+/, "").replace(/ ES[- ]Escucha[^ ]*\/[^ ]+/g, ""));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) e.preventDefault(); });
  const id = win.webContents.id;
  // Catch player keys even while the YouTube iframe has focus (rules in playerKey above).
  win.webContents.on("before-input-event", (event, input) => {
    const key = playerKey(input, focusKind.get(id) || "none");
    if (!key) return;
    event.preventDefault();
    win.webContents.send("player:key", key);
  });
  win.on("closed", () => focusKind.delete(id));
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(async () => {
  if (storageError) {
    dialog.showErrorBox("无法使用数据目录", `数据目录不可写入。\n\n${storageError.message}`);
    app.quit(); return;
  }
  protocol.handle("escucha-file", async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!MEDIA_EXT.test(filePath) || !fs.existsSync(filePath)) return new Response("not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    return new Response(res.body, { status: 200, headers: { "Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": "*" } });
  });
  createWindow();
  // Cleanup runs after the window is up, so it never delays startup.
  readConfig().then((s) => runCleanup(s.cleanupPolicy, { startup: true })).catch((e) => diagnostic("startup cleanup", e));
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("before-quit", () => tiktok.shutdownPlayback());
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
