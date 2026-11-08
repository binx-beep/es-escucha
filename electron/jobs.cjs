// Recognition jobs (download → extract → whisper), so any stage can be cancelled.
const fsp = require("fs").promises;

const recognitionJobs = new Map();

function recognitionJob(jobId, mediaKey) {
  let job = recognitionJobs.get(jobId);
  if (!job) {
    job = { jobId, mediaKey, cancelled: false, child: null, window: null, tempFiles: new Set() };
    recognitionJobs.set(jobId, job);
  }
  return job;
}

function ensureRecognitionActive(jobId) {
  const job = recognitionJobs.get(jobId);
  if (!job || job.cancelled) throw new Error("识别已取消");
}

function sendRecognitionProgress(event, jobId, mediaKey, value) {
  const job = recognitionJobs.get(jobId);
  if (job && !job.cancelled && !event.sender.isDestroyed()) event.sender.send("recognition:progress", { ...value, jobId, mediaKey });
}

async function cancelJob(jobId) {
  const job = recognitionJobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  if (job.child && !job.child.killed) job.child.kill();
  if (job.window && !job.window.isDestroyed()) job.window.close();
  job.child = null; job.window = null;
  await Promise.all([...job.tempFiles].map((file) => fsp.rm(file, { force: true }).catch(() => {})));
  // Keep the cancelled entry: later steps of the same job must still see `cancelled`.
  setTimeout(() => recognitionJobs.delete(jobId), 10 * 60000).unref?.();
  return true;
}

module.exports = { recognitionJobs, recognitionJob, ensureRecognitionActive, sendRecognitionProgress, cancelJob };
