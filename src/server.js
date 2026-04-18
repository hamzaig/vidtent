import express from "express";
import multer from "multer";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compressVideo,
  createBrowserJobDefaults,
  createSampleJob,
  runJob
} from "./video-tool.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
const APP_DATA_DIR = path.join(ROOT_DIR, ".app-data");
const UPLOADS_DIR = path.join(APP_DATA_DIR, "uploads");
const OUTPUTS_DIR = path.join(APP_DATA_DIR, "outputs");
const TEMP_DIR = path.join(APP_DATA_DIR, "temp");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const jobs = new Map();
const compressStreamSessions = new Map();
const COMPRESS_STREAM_CHUNK_BYTES = 16 * 1024 * 1024;
const COMPRESS_STREAM_MAX_BYTES = 48 * 1024 * 1024 * 1024;

await Promise.all([
  fs.mkdir(UPLOADS_DIR, { recursive: true }),
  fs.mkdir(OUTPUTS_DIR, { recursive: true }),
  fs.mkdir(TEMP_DIR, { recursive: true })
]);

const compressUpload = multer({
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
    files: 1
  }
});

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
app.use(express.json({ limit: "4mb" }));

app.get("/api/app-info", (_request, response) => {
  response.json({
    rootDir: ROOT_DIR,
    sampleJob: createSampleJob(),
    browserDefaults: createBrowserJobDefaults(),
    compressorDefaults: {
      outputName: "compressed.mp4",
      crf: 23,
      preset: "medium",
      audioBitrate: "128k",
      convertFormat: false,
      targetFormat: "mp4"
    },
    compressStreamChunkBytes: COMPRESS_STREAM_CHUNK_BYTES
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

app.post("/api/jobs/compress-stream/init", async (request, response, next) => {
  try {
    const { originalName, totalBytes, metadata: rawMeta } = request.body || {};

    if (!originalName || typeof originalName !== "string") {
      response.status(400).json({ error: "originalName is required." });
      return;
    }

    const extension = path.extname(originalName).toLowerCase();

    if (!extension || !VIDEO_EXTENSIONS.has(extension)) {
      response.status(400).json({ error: `Unsupported file extension: ${extension || "(none)"}` });
      return;
    }

    const expectedTotalBytes = Number(totalBytes);

    if (!Number.isFinite(expectedTotalBytes) || expectedTotalBytes <= 0) {
      response.status(400).json({ error: "totalBytes must be the file size in bytes (positive number)." });
      return;
    }

    if (expectedTotalBytes > COMPRESS_STREAM_MAX_BYTES) {
      response.status(400).json({ error: "File exceeds maximum allowed size for streaming upload." });
      return;
    }

    const jobId = randomUUID();
    const dirPath = path.join(UPLOADS_DIR, jobId);
    await fs.mkdir(dirPath, { recursive: true });

    const metadata = parseCompressMetadataFromInitBody(rawMeta ?? {});
    const inputPath = path.join(dirPath, `input${extension}`);

    compressStreamSessions.set(jobId, {
      dirPath,
      originalName,
      metadata,
      inputPath,
      nextChunkIndex: 0,
      expectedTotalBytes
    });

    response.json({
      jobId,
      chunkSizeBytes: COMPRESS_STREAM_CHUNK_BYTES
    });
  } catch (error) {
    next(error);
  }
});

app.put("/api/jobs/compress-stream/:jobId/chunk", async (request, response, next) => {
  const jobId = request.params.jobId;
  const session = compressStreamSessions.get(jobId);

  if (!session) {
    response.status(404).json({ error: "Upload session not found or already finalized." });
    return;
  }

  try {
    const chunkIndex = Number(request.headers["x-chunk-index"]);

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      response.status(400).json({ error: "X-Chunk-Index header must be a non-negative integer." });
      return;
    }

    if (chunkIndex !== session.nextChunkIndex) {
      response
        .status(400)
        .json({ error: `Invalid chunk order: expected index ${session.nextChunkIndex}, got ${chunkIndex}.` });
      return;
    }

    const flags = chunkIndex === 0 ? "w" : "a";
    const writeStream = createWriteStream(session.inputPath, { flags });

    try {
      await pipeline(request, writeStream);
    } catch (error) {
      compressStreamSessions.delete(jobId);
      await cleanupPath(session.dirPath);
      throw error;
    }

    const stats = await fs.stat(session.inputPath);
    session.nextChunkIndex += 1;

    response.json({
      ok: true,
      receivedBytes: stats.size,
      nextChunkIndex: session.nextChunkIndex
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/compress-stream/:jobId/finalize", async (request, response, next) => {
  try {
    const jobId = request.params.jobId;
    const session = compressStreamSessions.get(jobId);

    if (!session) {
      response.status(404).json({ error: "Upload session not found or already finalized." });
      return;
    }

    let stats;
    try {
      stats = await fs.stat(session.inputPath);
    } catch {
      response.status(400).json({ error: "Uploaded file is missing." });
      return;
    }

    if (stats.size !== session.expectedTotalBytes) {
      response.status(400).json({
        error: `Size mismatch: expected ${session.expectedTotalBytes} bytes, got ${stats.size}.`
      });
      return;
    }

    compressStreamSessions.delete(jobId);

    const outputName = resolveCompressOutputName(session.originalName, session.metadata);
    const record = createJobRecord({
      id: jobId,
      mode: "compress",
      baseDir: session.dirPath,
      outputName
    });

    jobs.set(record.id, record);
    appendLog(record, `Queued compression for ${session.originalName} (chunked stream upload).`);

    const file = {
      path: session.inputPath,
      originalname: session.originalName
    };

    runCompressPipeline(record, file, session.metadata);

    response.status(202).json({ jobId: record.id });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/jobs/compress",
  assignUploadJobId,
  compressUpload.single("videoFile"),
  async (request, response, next) => {
    try {
      const file = request.file;

      if (!file) {
        throw new Error("videoFile is required.");
      }

      const metadata = parseCompressMetadata(request.body?.metadata);
      const outputName = resolveCompressOutputName(file.originalname, metadata);
      const record = createJobRecord({
        id: request.uploadJobId,
        mode: "compress",
        baseDir: path.join(UPLOADS_DIR, request.uploadJobId),
        outputName
      });

      jobs.set(record.id, record);
      appendLog(record, `Queued compression for ${file.originalname}.`);

      runCompressPipeline(record, file, metadata);

      response.status(202).json({ jobId: record.id });
    } catch (error) {
      await cleanupPath(path.join(UPLOADS_DIR, request.uploadJobId));
      next(error);
    }
  }
);

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
const server = app.listen(port, () => {
  console.log(`Video tool API listening on http://localhost:${port}`);
});

server.requestTimeout = 3_600_000;
server.headersTimeout = 3_610_000;

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
    finishedAt: null,
    progressPercent: null,
    progressLabel: null
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

async function runCompressPipeline(record, file, metadata) {
  const uploadDir = path.join(UPLOADS_DIR, record.id);
  const outputPath = path.join(OUTPUTS_DIR, `${record.id}-${record.outputName}`);

  record.status = "running";
  record.progressPercent = 0;
  record.progressLabel = "Encoding";

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    await compressVideo({
      inputPath: file.path,
      outputPath,
      crf: metadata.crf,
      preset: metadata.preset,
      audioBitrate: metadata.audioBitrate,
      convertFormat: metadata.convertFormat,
      onProgress(percent) {
        record.progressPercent = percent;
        record.progressLabel = "Encoding";
      },
      onLog(message) {
        appendLog(record, message);
      }
    });

    record.status = "completed";
    record.outputPath = outputPath;
    record.downloadUrl = `/api/jobs/${record.id}/download`;
    record.finishedAt = new Date().toISOString();
    record.progressPercent = 100;
    record.progressLabel = "Done";
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    record.finishedAt = new Date().toISOString();
    record.progressLabel = "Failed";
    appendLog(record, error.message);
  } finally {
    await cleanupPath(uploadDir);
  }
}

async function runPipeline(record, job, baseDir, options = {}) {
  record.status = "running";
  record.progressPercent = 0;
  record.progressLabel = "Encoding";

  try {
    const result = await runJob(job, baseDir, {
      configLabel: options.configLabel,
      onLog(message) {
        appendLog(record, message);
      },
      onProgress(percent) {
        record.progressPercent = percent;
        record.progressLabel = "Encoding";
      }
    });

    record.status = "completed";
    record.outputPath = result.outputPath;
    record.downloadUrl = `/api/jobs/${record.id}/download`;
    record.finishedAt = new Date().toISOString();
    record.progressPercent = 100;
    record.progressLabel = "Done";
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    record.finishedAt = new Date().toISOString();
    record.progressLabel = "Failed";
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

function defaultCompressMetadata() {
  return {
    outputName: null,
    crf: 23,
    preset: "medium",
    audioBitrate: "128k",
    convertFormat: false,
    targetFormat: "mp4"
  };
}

function normalizeCompressMetadataObject(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return defaultCompressMetadata();
  }

  const crf = metadata.crf != null ? Number(metadata.crf) : 23;
  const preset = metadata.preset != null ? String(metadata.preset) : "medium";
  const audioBitrate = metadata.audioBitrate != null ? String(metadata.audioBitrate) : "128k";

  if (!Number.isFinite(crf)) {
    throw new Error("metadata.crf must be a number.");
  }

  const convertFormat = Boolean(metadata.convertFormat);
  const targetFormat =
    typeof metadata.targetFormat === "string"
      ? metadata.targetFormat.trim().toLowerCase().replace(/^\./, "")
      : "mp4";

  return {
    outputName: typeof metadata.outputName === "string" ? metadata.outputName : null,
    crf,
    preset,
    audioBitrate,
    convertFormat,
    targetFormat
  };
}

function parseCompressMetadataFromInitBody(rawMeta) {
  if (rawMeta == null) {
    return defaultCompressMetadata();
  }

  if (typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
    return normalizeCompressMetadataObject(rawMeta);
  }

  if (typeof rawMeta === "string") {
    return parseCompressMetadata(rawMeta);
  }

  throw new Error("metadata must be an object or JSON string.");
}

function parseCompressMetadata(rawMetadata) {
  if (!rawMetadata) {
    return defaultCompressMetadata();
  }

  if (typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    return normalizeCompressMetadataObject(rawMetadata);
  }

  if (typeof rawMetadata !== "string") {
    throw new Error("metadata must be a string or object.");
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

  return normalizeCompressMetadataObject(metadata);
}

function resolveCompressOutputName(originalFilename, metadata) {
  const origExt = path.extname(originalFilename).toLowerCase();

  if (!origExt || !VIDEO_EXTENSIONS.has(origExt)) {
    throw new Error(`Unsupported input extension: ${origExt || "(none)"}`);
  }

  const trimmed = typeof metadata.outputName === "string" ? metadata.outputName.trim() : "";
  const fallbackBase = "compressed";
  const rawBase = trimmed ? sanitizeFilename(trimmed) : fallbackBase;
  const nameWithoutExt = path.basename(rawBase, path.extname(rawBase)) || fallbackBase;

  if (metadata.convertFormat) {
    const targetExt = normalizeTargetVideoExtension(metadata.targetFormat);
    return `${nameWithoutExt}${targetExt}`;
  }

  const requestedExt = path.extname(rawBase).toLowerCase();

  if (!requestedExt) {
    return `${nameWithoutExt}${origExt}`;
  }

  if (requestedExt !== origExt) {
    return `${nameWithoutExt}${origExt}`;
  }

  return rawBase;
}

function normalizeTargetVideoExtension(targetFormat) {
  const token = (targetFormat || "mp4").toString().trim().toLowerCase().replace(/^\./, "");
  const ext = `.${token}`;

  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported target format: ${ext}`);
  }

  return ext;
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
