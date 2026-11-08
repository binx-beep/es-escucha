// Local speech recognition with whisper.cpp (whisper-cli.exe).
const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { LEGACY_ROOT, dataDir, sub } = require("./paths.cjs");

const MODELS = {
  small: { file: "ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" },
  turbo: { file: "ggml-large-v3-turbo.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" },
  large: { file: "ggml-large-v3.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin" },
};
const VAD_MODEL = { file: "ggml-silero-v5.1.2.bin", url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" };

function enginePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "whisper", "Release", "whisper-cli.exe")
    : path.join(__dirname, "..", "resources", "whisper", "Release", "whisper-cli.exe");
}

const ownModelPath = (id) => path.join(sub("models"), MODELS[id].file);
const legacyModelPath = (id) => path.join(LEGACY_ROOT, "data", "models", MODELS[id].file);
/** Where the model is (own folder first, then ES Escucha 1's folder), or where it should be downloaded to. */
function modelPath(id) {
  const own = ownModelPath(id);
  if (fs.existsSync(own)) return own;
  const legacy = legacyModelPath(id);
  return fs.existsSync(legacy) ? legacy : own;
}
const usesLegacyModel = () => Object.keys(MODELS).some((id) => !fs.existsSync(ownModelPath(id)) && fs.existsSync(legacyModelPath(id)));
const vadModelPath = () => path.join(sub("models"), VAD_MODEL.file);

/** whisper.cpp is fastest with about one thread per physical core. */
function cpuCount() { return (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4; }
function autoThreads() {
  const n = cpuCount();
  if (n <= 4) return n;
  return Math.min(16, Math.max(4, Math.floor(n / 2)));
}
function threadCount(setting) {
  const n = Number(setting);
  return Number.isInteger(n) && n > 0 ? Math.min(n, cpuCount()) : autoThreads();
}

/** Word timings from whisper tokens; falls back to evenly spread words when tokens look unreliable. */
function wordTimings(item) {
  const segmentStart = Number(item.offsets?.from || 0) / 1000, segmentEnd = Number(item.offsets?.to || 0) / 1000;
  const sourceWords = String(item.text || "").trim().split(/\s+/).filter(Boolean);
  const tokens = Array.isArray(item.tokens) ? item.tokens : [];
  const groups = [];
  for (const token of tokens) {
    const text = String(token.text || "");
    if (!text.trim() || /^\[.*\]$/.test(text.trim())) continue;
    const start = Number(token.offsets?.from ?? token.t0 ?? 0) / (token.offsets?.from != null ? 1000 : 100);
    const end = Number(token.offsets?.to ?? token.t1 ?? 0) / (token.offsets?.to != null ? 1000 : 100);
    if (/^\s/.test(text) || !groups.length) groups.push({ text: text.trim(), start, end });
    else { groups.at(-1).text += text; groups.at(-1).end = end || groups.at(-1).end; }
  }
  const inside = (t) => t >= segmentStart - 1 && t <= segmentEnd + 1;
  if (groups.length === sourceWords.length && groups.every((w) => w.end >= w.start && inside(w.start) && inside(w.end))) {
    return groups.map((word, index) => ({ text: sourceWords[index], start: word.start || segmentStart, end: word.end || segmentEnd }));
  }
  const duration = Math.max(0, segmentEnd - segmentStart), count = Math.max(1, sourceWords.length);
  return sourceWords.map((text, index) => ({ text, start: segmentStart + (duration * index) / count, end: segmentStart + (duration * (index + 1)) / count }));
}

function runWhisper(args, job, onPercent) {
  return new Promise((resolve, reject) => {
    const child = spawn(enginePath(), args, { windowsHide: true, cwd: path.dirname(enginePath()) });
    job.child = child;
    let errors = "";
    child.stderr.on("data", (data) => {
      const text = data.toString();
      errors = (errors + text).slice(-8000);
      for (const match of text.matchAll(/progress\s*=\s*(\d+)%/gi)) onPercent(Math.max(0, Math.min(100, Number(match[1]))));
    });
    child.stdout.on("data", () => {}); // drain so the process never blocks on a full pipe
    child.on("error", reject);
    child.on("close", (code) => {
      if (job.child === child) job.child = null;
      code === 0 ? resolve() : reject(new Error(errors.trim().split(/\r?\n/).slice(-3).join("\n") || `识别失败 (${code})`));
    });
  });
}

/**
 * Transcribe a 16 kHz WAV to Spanish segments.
 * Speed settings: greedy decoding ("fast"), thread count, optional VAD (skips silence/music).
 */
async function transcribe({ wavPath, modelId, settings, job, onPercent }) {
  if (!MODELS[modelId]) throw new Error("未知模型");
  if (!fs.existsSync(enginePath())) throw new Error("本地识别引擎缺失（resources/whisper），请重新打包程序");
  const model = modelPath(modelId);
  if (!fs.existsSync(model)) throw new Error("请先下载所选识别模型");
  await fsp.mkdir(sub("temp"), { recursive: true });
  const output = path.join(sub("temp"), `subtitle-${Date.now()}`);
  job.tempFiles.add(wavPath); job.tempFiles.add(`${output}.json`);

  const base = ["-m", model, "-f", wavPath, "-l", "es", "-t", String(threadCount(settings.threads)), "-ojf", "-sow", "-pp", "-of", output];
  if (settings.speed !== "accurate") base.push("-bs", "1", "-bo", "1");
  const useVad = settings.vad && fs.existsSync(vadModelPath());
  try {
    await runWhisper(useVad ? [...base, "--vad", "-vm", vadModelPath()] : base, job, onPercent);
  } catch (error) {
    // Older whisper builds do not know --vad: retry once without it.
    if (!useVad || job.cancelled || !/unknown|invalid|vad/i.test(String(error.message))) throw error;
    await runWhisper(base, job, onPercent);
  }
  const parsed = JSON.parse(await fsp.readFile(`${output}.json`, "utf8"));
  return {
    jsonPath: `${output}.json`,
    segments: (parsed.transcription || [])
      .map((item) => ({ start: Number(item.offsets?.from || 0) / 1000, end: Number(item.offsets?.to || 0) / 1000, text: String(item.text || "").trim(), words: wordTimings(item) }))
      .filter((item) => item.text && !/^\[.*\]$|^\(.*\)$/.test(item.text)),
  };
}

module.exports = { MODELS, VAD_MODEL, modelPath, ownModelPath, usesLegacyModel, vadModelPath, enginePath, cpuCount, autoThreads, transcribe, wordTimings, dataDir };
