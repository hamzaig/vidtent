import { runCommand } from "./run.js";

const DEFAULT_FPS = 30;

export async function probeMedia(inputPath) {
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

  const durationRaw = Number(data.format?.duration);
  const durationSeconds =
    Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;

  return {
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    hasAudio,
    durationSeconds
  };
}

function parseFrameRate(value) {
  if (!value || value === "0/0") {
    return DEFAULT_FPS;
  }

  const [numerator, denominator] = String(value).split("/");
  const num = Number(numerator);
  const den = Number(denominator || 1);

  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return DEFAULT_FPS;
  }

  return Number((num / den).toFixed(3));
}
