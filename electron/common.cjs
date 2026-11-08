const { spawn } = require("child_process");
const fsp = require("fs").promises;
const path = require("path");
const { dataDir } = require("./paths.cjs");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`NETWORK_ERROR|${label}超时，请检查网络后重试。`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function diagnostic(label, error) {
  try {
    const folder = path.join(dataDir(), "logs");
    await fsp.mkdir(folder, { recursive: true });
    await fsp.appendFile(path.join(folder, "errors.log"), `${new Date().toISOString()} ${label}\n${String(error?.stack || error)}\n\n`);
  } catch { /* logging must never break the app */ }
}

function onlineError(error) {
  const detail = String(error?.message || error);
  if (/IP address is blocked|region|geo restricted|not available in your country/i.test(detail)) return new Error("REGION_BLOCKED|平台限制了当前网络或地区访问，请稍后重试或更换网络。");
  if (/private|unavailable|removed|not found/i.test(detail)) return new Error("VIDEO_UNAVAILABLE|该视频不可用、已删除或不是公开视频。");
  if (/Unexpected response|Unable to extract|cookies|login|Sign in|DPAPI/i.test(detail)) return new Error("LOGIN_REQUIRED|平台需要登录验证，请登录后重试（YouTube 可先在设置里更新解析器）。");
  return new Error("NETWORK_ERROR|网络连接或平台解析失败，请检查网络后重试。");
}

/** Run a command-line tool; resolves with stdout. `job.child` is set so it can be cancelled. */
function runTool(executable, args, onLine, job) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    if (job) job.child = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { const text = data.toString(); stdout += text; onLine?.(text); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (job?.child === child) job.child = null;
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `解析失败 (${code})`));
    });
  });
}

module.exports = { sleep, withTimeout, diagnostic, onlineError, runTool };
