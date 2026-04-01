import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBrowserJobDefaults, createSampleJob, runJob } from "./video-tool.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
const APP_DATA_DIR = path.join(ROOT_DIR, ".app-data");
const UPLOADS_DIR = path.join(APP_DATA_DIR, "uploads");
const OUTPUTS_DIR = path.join(APP_DATA_DIR, "outputs");
const TEMP_DIR = path.join(APP_DATA_DIR, "temp");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const jobs = new Map();

await Promise.all([
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
  fs.mkdir(OUTPUTS_DIR, { recursive: true }),
  fs.mkdir(TEMP_DIR, { recursive: true })
]);

const upload = multer({
  storage: multer.diskStorage({
    destination(request, _file, callback) {
      const uploadId = request.uploadJobId;
      const directory = path.join(UPLOADS_DIR, uploadId);

      fs.mkdir(directory, { recursive: true })
        .then(() => callback(null, directory))
        .catch((error) => callback(error));
    },
    filename(_request, file, callback) {
      callback(null, `${randomUUID()}-${sanitizeFilename(file.originalname)}`);
    }
  }),
  fileFilter(_request, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (file.mimetype.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Unsupported file type: ${file.originalname}`));
  },
  limits: {
    files: 50
  }
});

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/app-info", (_request, response) => {
  response.json({
    rootDir: ROOT_DIR,
    sampleJob: createSampleJob(),
    browserDefaults: createBrowserJobDefaults()
  });
});

app.post("/api/discover", async (request, response, next) => {
  try {
    const baseDir = resolveBaseDir(request.body?.baseDir);
    const requestedDirectory = request.body?.directory || ".";
    const directory = path.resolve(baseDir, requestedDirectory);
    const maxDepth = clampDepth(request.body?.maxDepth);
    const files = await scanVideoFiles(directory, baseDir, maxDepth);

    response.json({
      baseDir,
      directory: formatPath(baseDir, directory),
      files
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs", async (request, response, next) => {
  try {
    const baseDir = resolveBaseDir(request.body?.baseDir);
    const job = request.body?.job;

    if (!job || typeof job !== "object") {
      response.status(400).json({ error: "job is required." });
      return;
    }

    const record = createJobRecord({
      id: randomUUID(),
      mode: "paths",
      baseDir
    });

    jobs.set(record.id, record);
    appendLog(record, `Base directory: ${baseDir}`);
    appendLog(record, `Queued ${Array.isArray(job.clips) ? job.clips.length : 0} clip(s).`);

    runPathPipeline(record, job, baseDir);

    response.status(202).json({ jobId: record.id });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/jobs/upload",
  assignUploadJobId,
  upload.array("clipFiles", 50),
  async (request, response, next) => {
    try {
      const metadata = parseUploadMetadata(request.body?.metadata);
      const files = request.files || [];

      if (!files.length) {
        throw new Error("At least one video file is required.");
      }

      if (!Array.isArray(metadata.clips) || metadata.clips.length !== files.length) {
        throw new Error("Uploaded files and clip settings are out of sync.");
      }

      const record = createJobRecord({
        id: request.uploadJobId,
        mode: "upload",
        baseDir: path.join(UPLOADS_DIR, request.uploadJobId),
        outputName: ensureMp4Name(metadata.outputName)
      });

      jobs.set(record.id, record);
      appendLog(record, `Uploaded ${files.length} video file(s).`);
      appendLog(record, "No manual file paths required for this run.");

      runUploadPipeline(record, metadata, files);

      response.status(202).json({ jobId: record.id });
    } catch (error) {
      await cleanupPath(path.join(UPLOADS_DIR, request.uploadJobId));
      next(error);
    }
  }
);

app.get("/api/jobs/:jobId", (request, response) => {
  const record = jobs.get(request.params.jobId);

  if (!record) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  response.json(record);
});

app.get("/api/jobs/:jobId/download", async (request, response, next) => {
  try {
    const record = jobs.get(request.params.jobId);

    if (!record || record.status !== "completed" || !record.outputPath) {
      response.status(404).json({ error: "Output file is not ready yet." });
      return;
    }

    response.download(record.outputPath, record.outputName || path.basename(record.outputPath), {
      dotfiles: "allow"
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  response.status(500).json({
    error: error.message || "Unexpected server error."
  });
});

const hasBuiltFrontend = await pathExists(path.join(WEB_DIST_DIR, "index.html"));

if (hasBuiltFrontend) {
  app.use(express.static(WEB_DIST_DIR));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Video tool API listening on http://localhost:${port}`);
});

function assignUploadJobId(request, _response, next) {
  request.uploadJobId = randomUUID();
  next();
}

function createJobRecord({ id, mode, baseDir, outputName = null }) {
  return {
    id,
    mode,
    status: "queued",
    logs: [],
    outputPath: null,
    outputName,
    downloadUrl: null,
    error: null,
    baseDir,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
}

async function runPathPipeline(record, job, baseDir) {
  await runPipeline(record, job, baseDir, {
    configLabel: `Path job ${record.id}`
  });
}

async function runUploadPipeline(record, metadata, files) {
  const uploadDir = path.join(UPLOADS_DIR, record.id);
  const job = buildUploadJob(record, metadata, files);

  await runPipeline(record, job, uploadDir, {
    configLabel: `Upload job ${record.id}`,
    cleanupPaths: [uploadDir]
  });
}

async function runPipeline(record, job, baseDir, options = {}) {
  record.status = "running";

  try {
    const result = await runJob(job, baseDir, {
      configLabel: options.configLabel,
      onLog(message) {
        appendLog(record, message);
      }
    });

    record.status = "completed";
    record.outputPath = result.outputPath;
    record.downloadUrl = `/api/jobs/${record.id}/download`;
    record.finishedAt = new Date().toISOString();
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    record.finishedAt = new Date().toISOString();
    appendLog(record, error.message);
  } finally {
    await Promise.all((options.cleanupPaths || []).map((targetPath) => cleanupPath(targetPath)));
  }
}

function buildUploadJob(record, metadata, files) {
  const outputName = ensureMp4Name(metadata.outputName);

  return {
    output: path.join(OUTPUTS_DIR, `${record.id}-${outputName}`),
    workingDir: path.join(TEMP_DIR, record.id),
    removeAudio: Boolean(metadata.removeAudio),
    video: {
      width: metadata.video?.width,
      height: metadata.video?.height,
      fps: metadata.video?.fps,
      crf: metadata.video?.crf,
      preset: metadata.video?.preset
    },
    audio: {
      bitrate: metadata.audio?.bitrate,
      sampleRate: metadata.audio?.sampleRate
    },
    clips: metadata.clips.map((clip, index) => ({
      path: files[index].path,
      start: clip.start,
      end: clip.end,
      duration: clip.duration,
      removeAudio: Boolean(clip.removeAudio)
    }))
  };
}

function parseUploadMetadata(rawMetadata) {
  if (!rawMetadata) {
    throw new Error("metadata is required.");
  }

  let metadata;

  try {
    metadata = JSON.parse(rawMetadata);
  } catch {
    throw new Error("metadata must be valid JSON.");
  }

  if (!metadata || typeof metadata !== "object") {
    throw new Error("metadata must be an object.");
  }

  return metadata;
}

function appendLog(record, message) {
  record.logs.push(`${new Date().toLocaleTimeString()}  ${message}`);

  if (record.logs.length > 250) {
    record.logs = record.logs.slice(-250);
  }
}

function resolveBaseDir(baseDir) {
  if (!baseDir || typeof baseDir !== "string") {
    return ROOT_DIR;
  }

  return path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(ROOT_DIR, baseDir);
}

function clampDepth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 4;
  }

  return Math.max(0, Math.min(8, Math.trunc(number)));
}

async function scanVideoFiles(directory, baseDir, depthRemaining) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (depthRemaining > 0) {
        files.push(...(await scanVideoFiles(fullPath, baseDir, depthRemaining - 1)));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    files.push({
      absolutePath: fullPath,
      path: formatPath(baseDir, fullPath),
      name: entry.name
    });
  }

  return files;
}

function formatPath(baseDir, targetPath) {
  const relativePath = path.relative(baseDir, targetPath);

  if (!relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return relativePath ? `./${relativePath}` : ".";
  }

  return targetPath;
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video.mp4";
}

function ensureMp4Name(filename) {
  const safeName = sanitizeFilename(filename || "merged-video.mp4");
  return safeName.toLowerCase().endsWith(".mp4") ? safeName : `${safeName}.mp4`;
}

async function cleanupPath(targetPath) {
  if (!targetPath) {
    return;
  }

  await fs.rm(targetPath, { recursive: true, force: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
