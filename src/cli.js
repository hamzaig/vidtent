#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { compressVideo, isCompressSupportedExtension, runJobFromConfigPath, writeSampleConfig } from "./video-tool.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    await initConfig(args.slice(1));
    return;
  }

  if (command === "run") {
    await runMergeJob(args.slice(1));
    return;
  }

  if (command === "compress") {
    await runCompressCommand(args.slice(1));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`
video-tool

Usage:
  video-tool init [target-file] [--force]
  video-tool run <config-file> [--keep-temp]
  video-tool compress <input-video> [output-video] [--crf 23] [--preset medium] [--to mp4]

Commands:
  init        Create a sample JSON job file.
  run         Trim, normalize, and merge clips using ffmpeg.
  compress    Re-encode to reduce size. Output extension matches input unless you pass a
              different output path or use --to to set the container (e.g. mov → mp4).

Examples:
  video-tool init
  video-tool run ./examples/job.sample.json
  video-tool compress ./input/trailer.mp4
  video-tool compress ./input/trailer.mp4 ./output/trailer-small.mp4 --crf 26
  video-tool compress ./input/clip.mov --to mp4
  video-tool compress ./input/clip.mov ./out/final.mp4
  `.trim());
}

async function initConfig(args) {
  const force = args.includes("--force");
  const targetArg = args.find((value) => !value.startsWith("--")) || "video-job.json";
  const targetPath = path.resolve(process.cwd(), targetArg);

  await writeSampleConfig(targetPath, { force });
  console.log(`Sample config created at ${targetPath}`);
}

async function runMergeJob(args) {
  const keepTemp = args.includes("--keep-temp");
  const configArg = args.find((value) => !value.startsWith("--"));

  if (!configArg) {
    throw new Error("Config file is required. Example: video-tool run ./examples/job.sample.json");
  }

  await runJobFromConfigPath(path.resolve(process.cwd(), configArg), {
    keepTemp,
    onLog(message) {
      console.log(message);
    }
  });
}

function readFlagValue(args, flagName) {
  const index = args.indexOf(flagName);
  if (index === -1 || index === args.length - 1) {
    return null;
  }

  return args[index + 1];
}

async function runCompressCommand(args) {
  const positional = args.filter((value) => !value.startsWith("--"));
  const inputArg = positional[0];
  const outputArg = positional[1];

  if (!inputArg) {
    throw new Error("Input video is required. Example: video-tool compress ./clip.mp4");
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const inputExt = path.extname(inputPath).toLowerCase();

  const crfRaw = readFlagValue(args, "--crf");
  const presetRaw = readFlagValue(args, "--preset");
  const toRaw = readFlagValue(args, "--to");
  const crf = crfRaw != null ? Number(crfRaw) : 23;
  const preset = presetRaw != null ? String(presetRaw) : "medium";

  if (!Number.isFinite(crf)) {
    throw new Error("--crf must be a number.");
  }

  let targetExt = null;
  if (toRaw != null) {
    const normalized = toRaw.trim().toLowerCase().startsWith(".")
      ? toRaw.trim().toLowerCase()
      : `.${toRaw.trim().toLowerCase()}`;
    if (!isCompressSupportedExtension(normalized)) {
      throw new Error(`Unsupported --to format: ${normalized}`);
    }
    targetExt = normalized;
  }

  let outputPath;
  if (outputArg) {
    outputPath = path.resolve(process.cwd(), outputArg);
  } else {
    const directory = path.dirname(inputPath);
    const base = path.basename(inputPath, inputExt);
    const suffixExt = targetExt || inputExt;
    outputPath = path.join(directory, `${base}-compressed${suffixExt}`);
  }

  const outputExt = path.extname(outputPath).toLowerCase();
  if (targetExt && outputExt !== targetExt) {
    throw new Error(`Output path must end with ${targetExt} when using --to.`);
  }

  const convertFormat = Boolean(targetExt) || outputExt !== inputExt;

  await compressVideo({
    inputPath,
    outputPath,
    crf,
    preset,
    convertFormat,
    onLog(message) {
      console.log(message);
    }
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
