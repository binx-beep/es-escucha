const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
/** Subscribe and return an unsubscribe function (so React effects can clean up). */
const on = (channel) => (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("desktopAPI", {
  pickMedia: invoke("media:pick"),
  readMedia: invoke("media:read"),
  saveWav: invoke("audio:save"),
  modelStatus: invoke("model:status"),
  downloadModel: invoke("model:download"),
  deleteModel: invoke("model:delete"),
  downloadVadModel: invoke("model:download-vad"),
  transcribe: invoke("whisper:transcribe"),
  cancelRecognition: invoke("recognition:cancel"),
  cacheStats: invoke("cache:stats"),
  clearCache: invoke("cache:clear"),
  saveSettings: invoke("settings:save"),
  chooseStorageRoot: invoke("storage:choose"),
  updateParser: invoke("parser:update"),
  exportText: invoke("export:text"),
  resolveVideo: invoke("online:video"),
  downloadOnlineVideo: invoke("online:download"),
  prepareTikTokPlayback: invoke("tiktok:playback-prepare"),
  refreshTikTokPlayback: invoke("tiktok:playback-refresh"),
  releaseTikTokPlayback: invoke("tiktok:playback-release"),
  listDownloadedVideos: invoke("media:list-downloaded"),
  openDownloadedVideosFolder: invoke("media:open-folder"),
  deleteDownloadedVideos: invoke("media:delete-downloaded"),
  openTikTokLogin: invoke("tiktok:login"),
  getTikTokLoginStatus: invoke("tiktok:login-status"),
  logoutTikTok: invoke("tiktok:logout"),
  setFocusKind: (kind) => ipcRenderer.send("keys:focus-kind", String(kind)),
  mediaFetchUrl: (filePath) => `escucha-file://media/${encodeURIComponent(String(filePath))}`,
  onModelProgress: on("model:progress"),
  onOnlineStatus: on("online:status"),
  onRecognitionProgress: on("recognition:progress"),
  onPlayerKey: on("player:key"),
});
