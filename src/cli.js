#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { runJobFromConfigPath, writeSampleConfig } from "./video-tool.js";

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
    await runJob(args.slice(1));
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

Commands:
  init        Create a sample JSON job file.
  run         Trim, normalize, and merge clips using ffmpeg.

Examples:
  video-tool init
  video-tool run ./examples/job.sample.json
  `.trim());
}

async function initConfig(args) {
  const force = args.includes("--force");
  const targetArg = args.find((value) => !value.startsWith("--")) || "video-job.json";
  const targetPath = path.resolve(process.cwd(), targetArg);

  await writeSampleConfig(targetPath, { force });
  console.log(`Sample config created at ${targetPath}`);
}

async function runJob(args) {
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
