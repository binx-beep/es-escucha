// Where everything lives on disk. Resolved once at startup (before app "ready").
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

/** ES Escucha 1 kept its data here; models / yt-dlp found there are reused instead of re-downloaded. */
const LEGACY_ROOT = "D:\\codex HC\\ES Escucha";

const locationFile = () => path.join(app.getPath("appData"), "ES Escucha 2", "location.json");

function defaultRoot() {
  // Portable exe: keep data next to the exe (e.g. D:\杂\ES-Escucha-2\Escucha数据).
  const base = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, ".."));
  return path.join(base, "Escucha数据");
}

function chosenRoot() {
  try { return JSON.parse(fs.readFileSync(locationFile(), "utf8")).root || null; } catch { return null; }
}

let ROOT = null;
function resolveRoot() {
  if (ROOT) return ROOT;
  const candidates = [chosenRoot(), defaultRoot(), path.join(app.getPath("appData"), "ES Escucha 2", "data")].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      for (const sub of ["data", "user-data", "browser-cache"]) fs.mkdirSync(path.join(candidate, sub), { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      ROOT = candidate;
      return ROOT;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("没有可写入的数据目录");
}

function setChosenRoot(root) {
  fs.mkdirSync(path.dirname(locationFile()), { recursive: true });
  fs.writeFileSync(locationFile(), JSON.stringify({ root }, null, 2));
}

const root = () => resolveRoot();
const dataDir = () => path.join(resolveRoot(), "data");
const sub = (name) => path.join(dataDir(), name);

module.exports = { LEGACY_ROOT, resolveRoot, setChosenRoot, root, dataDir, sub };
