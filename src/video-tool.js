import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  crf: 20,
  preset: "medium",
  sampleRate: 48000,
  bitrate: "192k",
  fps: 30
};

export function createSampleJob() {
  return {
    output: "./output/final.mp4",
    workingDir: "./.video-tool-temp",
    removeAudio: false,
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      crf: 20,
      preset: "medium"
    },
    audio: {
      bitrate: "192k",
      sampleRate: 48000
    },
    clips: [
      {
        path: "./input/video-1.mp4",
        start: "00:00:01.000",
        end: "00:00:04.500",
        removeAudio: true
      },
      {
        path: "./input/video-2.mp4",
        start: 2,
        duration: 5
      },
      {
        path: "./input/video-3.mp4"
      }
    ]
  };
}

export function createBrowserJobDefaults() {
  return {
    outputName: "merged-video.mp4",
    removeAudio: false,
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      crf: 20,
      preset: "medium"
    },
    audio: {
      bitrate: "192k",
      sampleRate: 48000
    }
  };
}

export function buildSampleConfig() {
  return `${JSON.stringify(createSampleJob(), null, 2)}\n`;
}

export async function writeSampleConfig(targetPath, { force = false } = {}) {
  try {
    await fs.access(targetPath);
    if (!force) {
      throw new Error(`File already exists: ${targetPath}. Use --force to overwrite.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buildSampleConfig(), "utf8");
}

export async function runJobFromConfigPath(configPath, options = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const rawConfig = JSON.parse(await fs.readFile(resolvedConfigPath, "utf8"));
  return runJob(rawConfig, path.dirname(resolvedConfigPath), {
    ...options,
    configPath: resolvedConfigPath
  });
}

export async function runJob(rawConfig, configDir, options = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const keepTemp = Boolean(options.keepTemp);
  const log = createLogger(options.onLog);

  await ensureBinary("ffmpeg");
  await ensureBinary("ffprobe");

  const job = normalizeJob(rawConfig, resolvedConfigDir);
  const firstProbe = await probeMedia(job.clips[0].path);
  const targetVideo = buildTargetVideo(rawConfig, firstProbe);
  const tempDir = await makeTempDir(job.workingDir);
  const configLabel = options.configLabel || (options.configPath ? path.resolve(options.configPath) : resolvedConfigDir);

  log(`Config: ${configLabel}`);
  log(`Working directory: ${tempDir}`);
  log(`Target output: ${job.output}`);
  log(`Target video: ${targetVideo.width}x${targetVideo.height} @ ${targetVideo.fps}fps`);

  try {
    await fs.mkdir(path.dirname(job.output), { recursive: true });

    const segmentPaths = [];
    const outputHasAudio = !job.removeAudio;

    for (let index = 0; index < job.clips.length; index += 1) {
      const clip = job.clips[index];
      const probe = await probeMedia(clip.path);
      const segmentPath = path.join(tempDir, `segment-${String(index + 1).padStart(3, "0")}.mp4`);

      log(`Rendering clip ${index + 1}/${job.clips.length}: ${clip.path}`);
      await renderSegment({
        clip,
        probe,
        outputHasAudio,
        outputPath: segmentPath,
        targetVideo,
        audioOptions: job.audio
      });

      segmentPaths.push(segmentPath);
    }

    const concatListPath = path.join(tempDir, "concat-list.txt");
    const concatList = segmentPaths
      .map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`)
      .join("\n");

    await fs.writeFile(concatListPath, `${concatList}\n`, "utf8");

    log("Merging rendered clips...");
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      job.output
    ]);

    log(`Done: ${job.output}`);

    return {
      outputPath: job.output,
      targetVideo,
      tempDir: keepTemp ? tempDir : null,
      job
    };
  } finally {
    if (!keepTemp) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      log(`Temp files kept at ${tempDir}`);
    }
  }
}

function createLogger(onLog) {
  return typeof onLog === "function" ? onLog : () => {};
}

function normalizeJob(rawConfig, configDir) {
  if (!rawConfig || typeof rawConfig !== "object") {
    throw new Error("Config must be a JSON object.");
  }

  if (!Array.isArray(rawConfig.clips) || rawConfig.clips.length === 0) {
    throw new Error("Config must contain a non-empty clips array.");
  }

  if (!rawConfig.output || typeof rawConfig.output !== "string") {
    throw new Error("Config must contain an output path.");
  }

  const clips = rawConfig.clips.map((clip, index) => normalizeClip(clip, index, configDir));
  const audio = {
    bitrate: rawConfig.audio?.bitrate || DEFAULTS.bitrate,
    sampleRate: ensurePositiveNumber(rawConfig.audio?.sampleRate ?? DEFAULTS.sampleRate, "audio.sampleRate")
  };

  return {
    output: path.resolve(configDir, rawConfig.output),
    workingDir: path.resolve(configDir, rawConfig.workingDir || ".video-tool-temp"),
    removeAudio: Boolean(rawConfig.removeAudio),
    audio,
    clips
  };
}

function normalizeClip(clip, index, configDir) {
  if (!clip || typeof clip !== "object") {
    throw new Error(`Clip ${index + 1} must be an object.`);
  }

  if (!clip.path || typeof clip.path !== "string") {
    throw new Error(`Clip ${index + 1} must include a path.`);
  }

  if (clip.end != null && clip.duration != null) {
    throw new Error(`Clip ${index + 1} cannot contain both end and duration.`);
  }

  const start = clip.start != null ? parseTimeValue(clip.start, `clips[${index}].start`) : null;
  const end = clip.end != null ? parseTimeValue(clip.end, `clips[${index}].end`) : null;
  const duration = clip.duration != null ? parseTimeValue(clip.duration, `clips[${index}].duration`) : null;

  if (start != null && start < 0) {
    throw new Error(`Clip ${index + 1} start must be >= 0.`);
  }

  if (duration != null && duration <= 0) {
    throw new Error(`Clip ${index + 1} duration must be > 0.`);
  }

  if (end != null && start != null && end <= start) {
    throw new Error(`Clip ${index + 1} end must be greater than start.`);
  }

  return {
    path: path.resolve(configDir, clip.path),
    start,
    end,
    duration,
    removeAudio: Boolean(clip.removeAudio)
  };
}

function buildTargetVideo(rawConfig, firstProbe) {
  const width = ensurePositiveInteger(rawConfig.video?.width ?? firstProbe.width, "video.width");
  const height = ensurePositiveInteger(rawConfig.video?.height ?? firstProbe.height, "video.height");
  const fps = ensurePositiveNumber(rawConfig.video?.fps ?? firstProbe.fps ?? DEFAULTS.fps, "video.fps");
  const crf = ensurePositiveInteger(rawConfig.video?.crf ?? DEFAULTS.crf, "video.crf");
  const preset = String(rawConfig.video?.preset || DEFAULTS.preset);

  return { width, height, fps, crf, preset };
}

async function renderSegment({
  clip,
  probe,
  outputHasAudio,
  outputPath,
  targetVideo,
  audioOptions
}) {
  const args = ["-y", "-i", clip.path];
  const useSilentAudio = outputHasAudio && (clip.removeAudio || !probe.hasAudio);

  if (useSilentAudio) {
    args.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${audioOptions.sampleRate}`);
  }

  if (clip.start != null) {
    args.push("-ss", formatTime(clip.start));
  }

  const clipDuration = getClipDuration(clip);
  if (clipDuration != null) {
    args.push("-t", formatTime(clipDuration));
  }

  args.push("-map", "0:v:0");

  if (outputHasAudio) {
    args.push("-map", useSilentAudio ? "1:a:0" : "0:a:0");
  }

  const videoFilter = [
    `scale=${targetVideo.width}:${targetVideo.height}:force_original_aspect_ratio=decrease`,
    `pad=${targetVideo.width}:${targetVideo.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${targetVideo.fps}`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");

  args.push(
    "-vf",
    videoFilter,
    "-c:v",
    "libx264",
    "-preset",
    targetVideo.preset,
    "-crf",
    String(targetVideo.crf),
    "-pix_fmt",
    "yuv420p"
  );

  if (outputHasAudio) {
    if (!useSilentAudio) {
      args.push("-af", `aresample=${audioOptions.sampleRate}`);
    }

    args.push(
      "-c:a",
      "aac",
      "-b:a",
      audioOptions.bitrate,
      "-ar",
      String(audioOptions.sampleRate),
      "-ac",
      "2",
      "-shortest"
    );
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputPath);

  await runCommand("ffmpeg", args);
}

function getClipDuration(clip) {
  if (clip.duration != null) {
    return clip.duration;
  }

  if (clip.end != null) {
    return clip.start != null ? clip.end - clip.start : clip.end;
  }

  return null;
}

async function probeMedia(inputPath) {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    inputPath
  ]);

  const data = JSON.parse(output);
  const videoStream = data.streams?.find((stream) => stream.codec_type === "video");
  const hasAudio = data.streams?.some((stream) => stream.codec_type === "audio") || false;

  if (!videoStream) {
    throw new Error(`No video stream found in ${inputPath}`);
  }

  return {
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    hasAudio
  };
}

function parseFrameRate(value) {
  if (!value || value === "0/0") {
    return DEFAULTS.fps;
  }

  const [numerator, denominator] = String(value).split("/");
  const num = Number(numerator);
  const den = Number(denominator || 1);

  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return DEFAULTS.fps;
  }

  return Number((num / den).toFixed(3));
}

async function ensureBinary(command) {
  await runCommand(command, ["-version"]);
}

async function makeTempDir(baseDir) {
  await fs.mkdir(baseDir, { recursive: true });
  const tempDir = path.join(baseDir, `job-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(`${command} exited with code ${code}\n${stderr.trim()}`));
    });
  });
}

function parseTimeValue(value, fieldName) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName} must be a valid number.`);
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a number or time string.`);
  }

  const trimmed = value.trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`${fieldName} must use seconds or HH:MM:SS(.ms).`);
  }

  const normalized = parts.map((part) => Number(part));
  if (normalized.some((part) => !Number.isFinite(part))) {
    throw new Error(`${fieldName} contains an invalid time value.`);
  }

  if (parts.length === 2) {
    return normalized[0] * 60 + normalized[1];
  }

  return normalized[0] * 3600 + normalized[1] * 60 + normalized[2];
}

function formatTime(seconds) {
  return Number(seconds).toFixed(3);
}

function ensurePositiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return number;
}

function ensurePositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return number;
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}
