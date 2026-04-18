import path from "node:path";
import { runFfmpegWithProgress } from "../ffmpeg/ffmpeg-progress.js";
import { ensureBinary, runCommand } from "../ffmpeg/run.js";
import { probeMedia } from "../ffmpeg/probe.js";

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);

/**
 * Re-encode a single video for smaller size.
 * By default the output container matches the input (e.g. .mp4 → .mp4).
 * Set `convertFormat: true` to allow a different output extension (e.g. .mov → .mp4); encoding follows the output container.
 */
export async function compressVideo(options = {}) {
  const {
    inputPath,
    outputPath,
    crf = 23,
    preset = "medium",
    audioBitrate = "128k",
    convertFormat = false,
    onLog,
    onProgress
  } = options;

  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("compressVideo requires inputPath.");
  }

  if (!outputPath || typeof outputPath !== "string") {
    throw new Error("compressVideo requires outputPath.");
  }

  const inputExt = path.extname(inputPath).toLowerCase();
  const outputExt = path.extname(outputPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(inputExt)) {
    throw new Error(`Unsupported input extension: ${inputExt || "(none)"}`);
  }

  if (!convertFormat && outputExt !== inputExt) {
    throw new Error(
      `Output extension must match input (${inputExt}); got ${outputExt || "(none)"}. Enable format conversion to use a different container.`
    );
  }

  if (!SUPPORTED_EXTENSIONS.has(outputExt)) {
    throw new Error(`Unsupported output extension: ${outputExt || "(none)"}`);
  }

  const log = typeof onLog === "function" ? onLog : () => {};

  await ensureBinary("ffmpeg");
  await ensureBinary("ffprobe");

  const probe = await probeMedia(inputPath);
  const containerExt = outputExt;
  const built = buildCompressArgs({
    inputPath,
    outputPath,
    ext: containerExt,
    crf: Number(crf),
    preset: String(preset),
    hasAudio: probe.hasAudio,
    audioBitrate: String(audioBitrate)
  });

  const modeLabel = convertFormat ? `${inputExt} → ${outputExt}` : inputExt;
  log(`Compressing: ${inputPath} → ${outputPath} (${modeLabel}, CRF ${built.meta.crfDisplay}, preset ${preset})`);

  const durationSeconds = probe.durationSeconds && probe.durationSeconds > 0 ? probe.durationSeconds : 0;
  await runFfmpegWithProgress(built.ffmpegArgs, {
    durationSeconds,
    onProgress: typeof onProgress === "function" ? onProgress : null
  });

  log(`Done: ${outputPath}`);

  return { outputPath, inputExt, outputExt, hasAudio: probe.hasAudio, convertFormat: Boolean(convertFormat) };
}

export function isCompressSupportedExtension(ext) {
  return SUPPORTED_EXTENSIONS.has(String(ext).toLowerCase());
}

function buildCompressArgs({ inputPath, outputPath, ext, crf, preset, hasAudio, audioBitrate }) {
  const base = ["-y", "-i", inputPath];
  let crfDisplay = crf;

  switch (ext) {
    case ".mp4":
    case ".m4v":
      return {
        meta: { crfDisplay },
        ffmpegArgs: [
          ...base,
          "-c:v",
          "libx264",
          "-preset",
          preset,
          "-crf",
          String(clampCrfH264(crf)),
          "-pix_fmt",
          "yuv420p",
          ...(hasAudio ? ["-c:a", "aac", "-b:a", audioBitrate] : ["-an"]),
          "-movflags",
          "+faststart",
          outputPath
        ]
      };
    case ".mov":
      return {
        meta: { crfDisplay },
        ffmpegArgs: [
          ...base,
          "-c:v",
          "libx264",
          "-preset",
          preset,
          "-crf",
          String(clampCrfH264(crf)),
          "-pix_fmt",
          "yuv420p",
          ...(hasAudio ? ["-c:a", "aac", "-b:a", audioBitrate] : ["-an"]),
          outputPath
        ]
      };
    case ".mkv":
      return {
        meta: { crfDisplay },
        ffmpegArgs: [
          ...base,
          "-c:v",
          "libx264",
          "-preset",
          preset,
          "-crf",
          String(clampCrfH264(crf)),
          "-pix_fmt",
          "yuv420p",
          ...(hasAudio ? ["-c:a", "aac", "-b:a", audioBitrate] : ["-an"]),
          outputPath
        ]
      };
    case ".avi":
      return {
        meta: { crfDisplay },
        ffmpegArgs: [
          ...base,
          "-c:v",
          "libx264",
          "-preset",
          preset,
          "-crf",
          String(clampCrfH264(crf)),
          "-pix_fmt",
          "yuv420p",
          ...(hasAudio ? ["-c:a", "libmp3lame", "-b:a", "192k"] : ["-an"]),
          outputPath
        ]
      };
    case ".webm": {
      const vp9Crf = mapH264CrfToVp9(crf);
      crfDisplay = vp9Crf;
      return {
        meta: { crfDisplay },
        ffmpegArgs: [
          ...base,
          "-c:v",
          "libvpx-vp9",
          "-crf",
          String(vp9Crf),
          "-b:v",
          "0",
          "-row-mt",
          "1",
          ...(hasAudio ? ["-c:a", "libopus", "-b:a", "96k"] : ["-an"]),
          outputPath
        ]
      };
    }
    default:
      throw new Error(`No compression profile for extension: ${ext}`);
  }
}

function clampCrfH264(value) {
  const n = Number.isFinite(value) ? Math.round(value) : 23;
  return Math.min(51, Math.max(0, n));
}

function mapH264CrfToVp9(h264Crf) {
  const base = clampCrfH264(h264Crf);
  const shifted = base + 12;
  return Math.min(63, Math.max(4, shifted));
}
