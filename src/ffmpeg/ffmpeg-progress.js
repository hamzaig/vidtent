import { spawn } from "node:child_process";

/**
 * Run ffmpeg and report rough encode progress (0–100) from stderr `time=` vs total duration.
 */
export function runFfmpegWithProgress(args, options = {}) {
  const { durationSeconds = 0, onProgress } = options;

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    let lastEmitted = -1;

    const emit = (value) => {
      const clamped = Math.min(100, Math.max(0, Math.round(value)));
      if (clamped !== lastEmitted) {
        lastEmitted = clamped;
        if (typeof onProgress === "function") {
          onProgress(clamped);
        }
      }
    };

    child.stdout.on("data", () => {});

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (!durationSeconds || durationSeconds <= 0 || typeof onProgress !== "function") {
        return;
      }

      const matches = text.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g);
      for (const match of matches) {
        const seconds = parseFfmpegTime(match[1], match[2], match[3]);
        const ratio = seconds / durationSeconds;
        emit(ratio * 100);
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        emit(100);
        resolve(stderr.trim());
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}\n${stderr.trim()}`));
    });
  });
}

function parseFfmpegTime(hours, minutes, seconds) {
  const h = Number(hours);
  const m = Number(minutes);
  const s = Number(seconds);
  if (![h, m, s].every((n) => Number.isFinite(n))) {
    return 0;
  }
  return h * 3600 + m * 60 + s;
}
