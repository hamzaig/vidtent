import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { getCompressEstimates } from "./compress-estimate.js";

const PRESET_OPTIONS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"];
const TARGET_FORMAT_OPTIONS = [
  { value: "mp4", label: "MP4 (.mp4)" },
  { value: "mov", label: "QuickTime (.mov)" },
  { value: "m4v", label: "M4V (.m4v)" },
  { value: "mkv", label: "Matroska (.mkv)" },
  { value: "webm", label: "WebM (.webm)" },
  { value: "avi", label: "AVI (.avi)" }
];
const MIN_TRIM_GAP = 0.05;

/** Above this size, skip <video> preview — decoding large blobs often crashes Chrome (e.g. error 5). */
const MAX_BROWSER_VIDEO_PREVIEW_BYTES = 72 * 1024 * 1024;

/**
 * Single-request browser uploads above this often crash Chrome (error 5) or time out — use CLI instead.
 * (Chunked/resumable upload is not implemented in this app.)
 */
const MAX_BROWSER_SINGLE_UPLOAD_BYTES = 512 * 1024 * 1024;

export default function App() {
  const fileInputRef = useRef(null);
  const compressInputRef = useRef(null);
  const videoRefs = useRef({});
  const latestClipsRef = useRef([]);

  const [job, setJob] = useState(createEmptyJob());
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState("idle");
  const [jobLogs, setJobLogs] = useState([]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("merged-video.mp4");
  const [serverMessage, setServerMessage] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [workflow, setWorkflow] = useState("merge");
  const [compress, setCompress] = useState(createDefaultCompressState());
  const [transferPercent, setTransferPercent] = useState(null);
  const [processPercent, setProcessPercent] = useState(null);
  const [processLabel, setProcessLabel] = useState(null);

  useEffect(() => {
    let ignore = false;

    async function loadAppInfo() {
      try {
        const response = await fetch("/api/app-info");
        const data = await response.json();

        if (ignore) {
          return;
        }

        startTransition(() => {
          setJob(createJobFromDefaults(data.browserDefaults));
          if (data.compressorDefaults) {
            setCompress((current) => ({
              ...current,
              ...createDefaultCompressState(),
              ...data.compressorDefaults
            }));
          }
        });
      } catch (error) {
        if (!ignore) {
          setServerMessage(error.message);
        }
      }
    }

    loadAppInfo();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    latestClipsRef.current = job.clips;
  }, [job.clips]);

  useEffect(
    () => () => {
      destroyClipResources(latestClipsRef.current);
    },
    []
  );

  useEffect(
    () => () => {
      if (compress.previewUrl) {
        URL.revokeObjectURL(compress.previewUrl);
      }
    },
    [compress.previewUrl]
  );

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`);
        const data = await response.json();

        setJobStatus(data.status);
        setJobLogs(data.logs || []);
        setServerMessage(data.error || "");
        setDownloadUrl(data.downloadUrl || "");
        setDownloadName(data.outputName || "merged-video.mp4");
        setProcessPercent(typeof data.progressPercent === "number" ? data.progressPercent : null);
        setProcessLabel(typeof data.progressLabel === "string" ? data.progressLabel : null);

        if (data.status === "completed" || data.status === "failed") {
          clearInterval(timer);
        }
      } catch (error) {
        setServerMessage(error.message);
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [jobId]);

  async function handleRunJob() {
    if (!job.clips.length) {
      setServerMessage("Upload at least one video first.");
      return;
    }

    const oversized = job.clips.filter((clip) => isFileTooLargeForBrowserUpload(clip.file));
    if (oversized.length) {
      setServerMessage(
        `One or more clips exceed the browser upload limit (${formatBytes(MAX_BROWSER_SINGLE_UPLOAD_BYTES)} per file). Use the CLI instead. Example: video-tool run ./your-job.json`
      );
      return;
    }

    setServerMessage("");
    setJobId(null);
    setJobStatus("submitting");
    setJobLogs([]);
    setDownloadUrl("");
    setTransferPercent(0);
    setProcessPercent(null);
    setProcessLabel(null);

    try {
      const formData = new FormData();
      formData.append("metadata", JSON.stringify(prepareUploadJob(job)));

      for (const clip of job.clips) {
        formData.append("clipFiles", clip.file, clip.file.name);
      }

      const data = await postFormDataWithProgress("/api/jobs/upload", formData, (percent) => {
        startTransition(() => setTransferPercent(percent));
      });

      setTransferPercent(null);
      setJobId(data.jobId);
      setJobStatus("queued");
    } catch (error) {
      setTransferPercent(null);
      setJobStatus("failed");
      setServerMessage(error.message);
    }
  }

  async function handleRunCompress() {
    if (!compress.file) {
      setServerMessage("Select a video file first.");
      return;
    }

    setServerMessage("");
    setJobId(null);
    setJobStatus("submitting");
    setJobLogs([]);
    setDownloadUrl("");
    setTransferPercent(0);
    setProcessPercent(null);
    setProcessLabel(null);

    try {
      const metadataPayload = {
        outputName: compress.outputName.trim() || undefined,
        crf: Number(compress.crf),
        preset: compress.preset,
        audioBitrate: compress.audioBitrate,
        convertFormat: Boolean(compress.convertFormat),
        targetFormat: compress.convertFormat ? compress.targetFormat : undefined
      };

      const data = await uploadCompressInChunks(compress.file, metadataPayload, (percent) => {
        startTransition(() => setTransferPercent(percent));
      });

      setTransferPercent(null);
      setJobId(data.jobId);
      setJobStatus("queued");
    } catch (error) {
      setTransferPercent(null);
      setJobStatus("failed");
      setServerMessage(error.message);
    }
  }

  function handleFilesSelected(fileList) {
    const nextClips = Array.from(fileList || [])
      .filter((file) => isVideoFile(file))
      .map((file) => createClipFromFile(file));

    if (!nextClips.length) {
      setServerMessage("Please select video files only.");
      return;
    }

    setServerMessage("");
    startTransition(() => {
      setJob((current) => ({
        ...current,
        clips: [...current.clips, ...nextClips]
      }));
    });
  }

  function handleInputFiles(event) {
    handleFilesSelected(event.target.files);
    event.target.value = "";
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    handleFilesSelected(event.dataTransfer.files);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function setVideoRef(clipId, node) {
    if (node) {
      videoRefs.current[clipId] = node;
      return;
    }

    delete videoRefs.current[clipId];
  }

  function updateTopLevel(field, value) {
    setJob((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateNested(section, field, value) {
    setJob((current) => ({
      ...current,
      [section]: {
        ...current[section],
        [field]: value
      }
    }));
  }

  function updateClip(index, field, value) {
    setJob((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) =>
        clipIndex === index ? applyClipFieldUpdate(clip, field, value) : clip
      )
    }));
  }

  function updateClipRange(index, nextStart, nextEnd) {
    setJob((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) =>
        clipIndex === index ? applyVisualRange(clip, nextStart, nextEnd) : clip
      )
    }));
  }

  function updateClipPlayback(index, currentTime) {
    setJob((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) =>
        clipIndex === index
          ? {
              ...clip,
              currentTime
            }
          : clip
      )
    }));
  }

  function handleClipMetadata(index, event) {
    const durationSeconds = Number(event.currentTarget.duration) || 0;

    setJob((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) =>
        clipIndex === index
          ? normalizeClipAfterMetadata({
              ...clip,
              durationSeconds,
              currentTime: Math.min(clip.currentTime || 0, durationSeconds)
            })
          : clip
      )
    }));
  }

  function handleClipTimeUpdate(index, event) {
    updateClipPlayback(index, Number(event.currentTarget.currentTime) || 0);
  }

  function seekVideo(index, targetSeconds) {
    const clip = job.clips[index];
    if (!clip) {
      return;
    }

    const video = videoRefs.current[clip.id];
    if (!video) {
      return;
    }

    const safeTarget = clampSeconds(
      targetSeconds,
      0,
      Math.max((clip.durationSeconds || 0) - MIN_TRIM_GAP, 0)
    );

    video.currentTime = safeTarget;
    video.pause();
    updateClipPlayback(index, safeTarget);
  }

  function setRangeFromPlayer(index, boundary) {
    const clip = job.clips[index];
    if (!clip) {
      return;
    }

    const video = videoRefs.current[clip.id];
    const playerTime = Number(video?.currentTime) || 0;
    const currentStart = getEffectiveStartSeconds(clip);
    const currentEnd = getEffectiveEndSeconds(clip);

    if (boundary === "start") {
      updateClipRange(index, playerTime, currentEnd);
      return;
    }

    updateClipRange(index, currentStart, playerTime);
  }

  function setRangeFromSlider(index, boundary, rawValue) {
    const clip = job.clips[index];
    if (!clip) {
      return;
    }

    const value = Number(rawValue);
    const currentStart = getEffectiveStartSeconds(clip);
    const currentEnd = getEffectiveEndSeconds(clip);

    if (boundary === "start") {
      updateClipRange(index, value, currentEnd);
      seekVideo(index, value);
      return;
    }

    updateClipRange(index, currentStart, value);
    seekVideo(index, value);
  }

  function resetClipCut(index) {
    setJob((current) => ({
      ...current,
      clips: current.clips.map((clip, clipIndex) =>
        clipIndex === index
          ? {
              ...clip,
              start: "",
              end: "",
              duration: ""
            }
          : clip
      )
    }));

    const clip = job.clips[index];
    if (clip) {
      seekVideo(index, 0);
    }
  }

  function removeClip(index) {
    const removedClip = job.clips[index];

    setJob((current) => ({
      ...current,
      clips: current.clips.filter((_clip, clipIndex) => clipIndex !== index)
    }));

    destroyClipResources([removedClip]);
  }

  function moveClip(index, direction) {
    setJob((current) => {
      const nextIndex = index + direction;

      if (nextIndex < 0 || nextIndex >= current.clips.length) {
        return current;
      }

      const clips = [...current.clips];
      const [selected] = clips.splice(index, 1);
      clips.splice(nextIndex, 0, selected);

      return {
        ...current,
        clips
      };
    });
  }

  function duplicateClip(index) {
    const selected = job.clips[index];
    if (!selected) {
      return;
    }

    const copy = createClipFromFile(selected.file, {
      start: selected.start,
      end: selected.end,
      duration: selected.duration,
      removeAudio: selected.removeAudio,
      durationSeconds: selected.durationSeconds,
      currentTime: selected.currentTime
    });

    setJob((current) => {
      const clips = [...current.clips];
      clips.splice(index + 1, 0, copy);

      return {
        ...current,
        clips
      };
    });
  }

  function resetJob() {
    fetch("/api/app-info")
      .then((response) => response.json())
      .then((data) => {
        destroyClipResources(job.clips);

        if (compress.previewUrl) {
          URL.revokeObjectURL(compress.previewUrl);
        }

        startTransition(() => {
          setJob(createJobFromDefaults(data.browserDefaults));
          setCompress({
            ...createDefaultCompressState(),
            ...(data.compressorDefaults || {})
          });
          setJobId(null);
          setJobStatus("idle");
          setJobLogs([]);
          setDownloadUrl("");
          setServerMessage("");
          setTransferPercent(null);
          setProcessPercent(null);
          setProcessLabel(null);
        });
      })
      .catch((error) => {
        setServerMessage(error.message);
      });
  }

  function handleWorkflowChange(nextWorkflow) {
    setWorkflow(nextWorkflow);
    setServerMessage("");
  }

  function handleCompressFileSelected(fileList) {
    const file = Array.from(fileList || []).find((candidate) => isVideoFile(candidate));

    if (!file) {
      setServerMessage("Please select a video file only.");
      return;
    }

    setServerMessage("");

    setCompress((current) => {
      if (current.previewUrl) {
        URL.revokeObjectURL(current.previewUrl);
      }

      return {
        ...current,
        file,
        previewUrl: URL.createObjectURL(file),
        outputName: buildDefaultCompressOutputName(file.name, current.convertFormat, current.targetFormat)
      };
    });
  }

  function updateCompressField(field, value) {
    setCompress((current) => ({
      ...current,
      [field]: value
    }));
  }

  function setCompressConvertFormat(enabled) {
    setCompress((current) => {
      const next = { ...current, convertFormat: enabled };
      if (current.file) {
        next.outputName = buildDefaultCompressOutputName(current.file.name, enabled, current.targetFormat);
      }
      return next;
    });
  }

  function setCompressTargetFormat(format) {
    setCompress((current) => {
      const next = { ...current, targetFormat: format };
      if (current.convertFormat && current.file) {
        next.outputName = buildDefaultCompressOutputName(current.file.name, true, format);
      }
      return next;
    });
  }

  const totalDurationHint = `${job.clips.length} clip${job.clips.length === 1 ? "" : "s"} ready`;

  const compressEstimate = useMemo(() => {
    if (workflow !== "compress" || !compress.file) {
      return null;
    }

    const crfNumber = compress.crf === "" || compress.crf == null ? 23 : Number(compress.crf);

    if (!Number.isFinite(crfNumber)) {
      return null;
    }

    const outputExtension = compress.convertFormat
      ? `.${String(compress.targetFormat).replace(/^\./, "").toLowerCase()}`
      : getVideoExtension(compress.file.name);
    const inputExtension = getVideoExtension(compress.file.name);

    return getCompressEstimates({
      inputBytes: compress.file.size,
      crf: crfNumber,
      preset: compress.preset,
      inputExtension: inputExtension || undefined,
      outputExtension: outputExtension || undefined,
      convertFormat: Boolean(compress.convertFormat)
    });
  }, [workflow, compress.file, compress.crf, compress.preset, compress.convertFormat, compress.targetFormat]);

  const compressHeroSummary = useMemo(() => {
    if (workflow !== "compress" || !compress.file) {
      return null;
    }
    const inExt = getVideoExtension(compress.file.name) || "(unknown)";
    const targetDot =
      compress.convertFormat && `.${String(compress.targetFormat).replace(/^\./, "").toLowerCase()}`;
    const outputSummary = compress.convertFormat
      ? `Convert + compress → ${targetDot}`
      : `Same container as input (${inExt})`;
    const estimatePart = compressEstimate
      ? ` · ~${formatBytes(compressEstimate.estimatedBytes)} est. size, ~${compressEstimate.qualityReductionPercent}% est. quality reduction`
      : "";
    return `${compress.file.name} · ${formatBytes(compress.file.size)} · ${outputSummary}${estimatePart} (upload uses chunked streaming)`;
  }, [workflow, compress.file, compress.convertFormat, compress.targetFormat, compressEstimate]);

  const mergeUploadBlocked = job.clips.some((clip) => clip.file && isFileTooLargeForBrowserUpload(clip.file));

  const showProgressBar =
    transferPercent != null ||
    (jobId != null &&
      typeof processPercent === "number" &&
      (jobStatus === "running" || jobStatus === "queued" || jobStatus === "submitting" || jobStatus === "completed"));

  const progressBarPercent =
    transferPercent != null ? transferPercent : Math.min(100, Math.max(0, processPercent ?? 0));

  const progressCaption =
    transferPercent != null
      ? `Uploading ${transferPercent}%`
      : typeof processPercent === "number"
        ? `${processLabel || "Processing"} ${processPercent}%`
        : "";

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy-wrap">
          <p className="eyebrow">AI Video Workflow Foundation</p>
          <div className="workflow-tabs" role="tablist" aria-label="Tool workflow">
            <button
              type="button"
              role="tab"
              aria-selected={workflow === "merge"}
              className={`workflow-tab ${workflow === "merge" ? "workflow-tab-active" : ""}`}
              onClick={() => handleWorkflowChange("merge")}
            >
              Clip merge
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workflow === "compress"}
              className={`workflow-tab ${workflow === "compress" ? "workflow-tab-active" : ""}`}
              onClick={() => handleWorkflowChange("compress")}
            >
              Video compressor
            </button>
          </div>
          <h1>Build The Base For AI-Narrated Videos.</h1>
          <p className="hero-copy">
            This workspace covers clip editing, merge export, and single-file compression. Later phases
            can add AI scripts, voices, text-to-speech, and narration aligned to the timeline.
          </p>
        </div>

        <div className="status-panel">
          <span className={`status-pill status-${jobStatus}`}>{jobStatus}</span>
          {showProgressBar ? (
            <div className="progress-wrap" aria-live="polite">
              <div className="progress-bar" role="progressbar" aria-valuenow={progressBarPercent} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress-fill" style={{ width: `${progressBarPercent}%` }} />
              </div>
              <p className="progress-caption">{progressCaption}</p>
            </div>
          ) : null}
          <p>
            {downloadUrl
              ? "Output is ready — use Download below."
              : workflow === "compress"
                ? compress.file
                  ? compressHeroSummary
                  : "Pick one video for compression."
                : totalDurationHint}
          </p>
          <div className="hero-actions">
            {workflow === "merge" ? (
              <button
                type="button"
                className="primary-button"
                onClick={handleRunJob}
                disabled={mergeUploadBlocked}
                title={
                  mergeUploadBlocked
                    ? `Each clip must be under ${formatBytes(MAX_BROWSER_SINGLE_UPLOAD_BYTES)} for browser upload`
                    : undefined
                }
              >
                Merge Videos
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={handleRunCompress}>
                Compress Video
              </button>
            )}
            {workflow === "merge" ? (
              <button type="button" className="secondary-button" onClick={openFilePicker}>
                Browse Videos
              </button>
            ) : (
              <button type="button" className="secondary-button" onClick={() => compressInputRef.current?.click()}>
                Browse Video
              </button>
            )}
            <button type="button" className="ghost-button" onClick={resetJob}>
              Reset
            </button>
            {downloadUrl ? (
              <a className="primary-link" href={downloadUrl} download={downloadName}>
                Download Final Video
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <input
        ref={compressInputRef}
        className="hidden-input"
        type="file"
        accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v"
        onChange={(event) => {
          handleCompressFileSelected(event.target.files);
          event.target.value = "";
        }}
      />

      {workflow === "merge" ? (
      <main className="layout-grid">
        <section className="stack">
          <article className="panel upload-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Step 1</p>
                <h2>Upload Videos</h2>
              </div>
              <span className="summary-chip">{totalDurationHint}</span>
            </div>

            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v"
              multiple
              onChange={handleInputFiles}
            />

            <div
              className={`dropzone ${isDragging ? "dropzone-active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <strong>Drag and drop videos here</strong>
              <p>or choose files with Browse</p>
              <button type="button" className="dropzone-button" onClick={openFilePicker}>
                Browse Files
              </button>
            </div>

            <div className="quick-notes">
              <p>Each uploaded file becomes one clip in order.</p>
              <p>Trimming is visual-only for now; narration sync can come in a later phase.</p>
            </div>
            {mergeUploadBlocked ? (
              <div className="upload-limit-banner">
                <strong>Clip too large for browser upload</strong>
                <p>
                  At least one file is over {formatBytes(MAX_BROWSER_SINGLE_UPLOAD_BYTES)}. The web UI sends the whole
                  file in one request, which often crashes Chrome (Aw, Snap / error 5) or times out. Prepare a JSON job
                  and run from a terminal:
                </p>
                <pre className="cli-snippet">
                  {`video-tool init ./my-job.json
# edit my-job.json clip paths, then:
video-tool run ./my-job.json`}
                </pre>
              </div>
            ) : null}
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Step 2</p>
                <h2>Visual Timeline Base</h2>
              </div>
            </div>

            <div className="clip-stack">
              {job.clips.length ? (
                job.clips.map((clip, index) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    index={index}
                    maxPreviewBytes={MAX_BROWSER_VIDEO_PREVIEW_BYTES}
                    setVideoRef={setVideoRef}
                    onMetadata={handleClipMetadata}
                    onTimeUpdate={handleClipTimeUpdate}
                    onMove={moveClip}
                    onDuplicate={duplicateClip}
                    onRemove={removeClip}
                    onFieldChange={updateClip}
                    onSliderChange={setRangeFromSlider}
                    onSetRangeFromPlayer={setRangeFromPlayer}
                    onSeek={seekVideo}
                    onResetCut={resetClipCut}
                  />
                ))
              ) : (
                <div className="empty-state">
                  <strong>No videos uploaded yet.</strong>
                  <p>Use Browse Videos or drag and drop.</p>
                </div>
              )}
            </div>
          </article>
        </section>

        <aside className="stack">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Step 3</p>
                <h2>Output And Future Narration Layer</h2>
              </div>
            </div>

            <div className="field-grid single-column">
              <label className="field">
                <span>Final file name</span>
                <input
                  value={job.outputName}
                  onChange={(event) => updateTopLevel("outputName", event.target.value)}
                  placeholder="merged-video.mp4"
                />
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={Boolean(job.removeAudio)}
                  onChange={(event) => updateTopLevel("removeAudio", event.target.checked)}
                />
                <span>Remove current audio from final video</span>
              </label>
            </div>
            <p className="clip-meta">
              Planned later: generated narration audio, AI voice selection, and auto-sync with the
              final timeline.
            </p>
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Optional</p>
                <h2>Render Settings</h2>
              </div>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Width</span>
                <input
                  type="number"
                  value={job.video.width}
                  onChange={(event) => updateNested("video", "width", event.target.value)}
                />
              </label>
              <label className="field">
                <span>Height</span>
                <input
                  type="number"
                  value={job.video.height}
                  onChange={(event) => updateNested("video", "height", event.target.value)}
                />
              </label>
              <label className="field">
                <span>FPS</span>
                <input
                  type="number"
                  step="0.001"
                  value={job.video.fps}
                  onChange={(event) => updateNested("video", "fps", event.target.value)}
                />
              </label>
              <label className="field">
                <span>CRF</span>
                <input
                  type="number"
                  value={job.video.crf}
                  onChange={(event) => updateNested("video", "crf", event.target.value)}
                />
              </label>
              <label className="field">
                <span>Preset</span>
                <select
                  value={job.video.preset}
                  onChange={(event) => updateNested("video", "preset", event.target.value)}
                >
                  {PRESET_OPTIONS.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Audio bitrate</span>
                <input
                  value={job.audio.bitrate}
                  onChange={(event) => updateNested("audio", "bitrate", event.target.value)}
                />
              </label>
              <label className="field">
                <span>Sample rate</span>
                <input
                  type="number"
                  value={job.audio.sampleRate}
                  onChange={(event) => updateNested("audio", "sampleRate", event.target.value)}
                />
              </label>
            </div>
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Runtime</p>
                <h2>Job Logs</h2>
              </div>
            </div>

            {serverMessage ? <p className="error-banner">{serverMessage}</p> : null}
            <pre className="log-panel">{jobLogs.length ? jobLogs.join("\n") : "Logs appear here after you start a merge."}</pre>
          </article>
        </aside>
      </main>
      ) : (
      <main className="layout-grid">
        <section className="stack">
          <article className="panel upload-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Compressor</p>
                <h2>Shrink One File</h2>
              </div>
              <span className="summary-chip">
                {compress.convertFormat
                  ? `Convert + compress → .${String(compress.targetFormat).replace(/^\./, "")}`
                  : "Same container as input (e.g. MP4 → MP4)"}
              </span>
            </div>

            <div
              className={`dropzone ${isDragging ? "dropzone-active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                handleCompressFileSelected(event.dataTransfer.files);
              }}
            >
              <strong>Drop a video here</strong>
              <p>
                {compress.convertFormat
                  ? "Output will use the target container you select below."
                  : "Output keeps the same extension as the source file."}{" "}
                Large files are sent in sequential chunks so the browser does not load the whole file at once.
              </p>
              <button type="button" className="dropzone-button" onClick={() => compressInputRef.current?.click()}>
                Browse One Video
              </button>
            </div>

            {compress.file ? (
              <div className="compress-preview">
                {isVideoPreviewTooHeavy(compress.file) ? (
                  <div className="preview-disabled-notice">
                    <strong>Preview disabled</strong>
                    <p>
                      This file is about {formatBytes(compress.file.size)}. Playing it in the browser can crash Chrome
                      (error 5 / out of memory). Compression still runs on the server — adjust settings below and run
                      compress.
                    </p>
                  </div>
                ) : (
                  <video
                    className="clip-video"
                    src={compress.previewUrl}
                    controls
                    playsInline
                    preload="none"
                  />
                )}
                <p className="clip-meta">
                  {compress.convertFormat
                    ? "The server forces the output extension to your selected target format."
                    : "If the file name extension does not match the source, the server corrects it to match the input."}
                </p>
              </div>
            ) : null}
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Settings</p>
                <h2>Encode Options</h2>
              </div>
            </div>

            {compress.file && compressEstimate ? (
              <div className="estimate-card">
                <p className="estimate-title">
                  Rough size estimate (MOV/MKV → MP4 assumes a much smaller H.264 delivery than source)
                </p>
                <div className="estimate-metrics">
                  <div className="estimate-block">
                    <span className="estimate-label">Estimated compressed size</span>
                    <strong className="estimate-value">~{formatBytes(compressEstimate.estimatedBytes)}</strong>
                    <span className="estimate-range">
                      Range ~{formatBytes(compressEstimate.estimatedLowBytes)} –{" "}
                      {formatBytes(compressEstimate.estimatedHighBytes)}
                    </span>
                    <span className="estimate-muted">
                      Original {formatBytes(compress.file.size)}
                      {compressEstimate.savingsPercent > 0 ? (
                        <>
                          {" "}
                          · ~{compressEstimate.savingsPercent}% smaller file
                          {compressEstimate.percentOfOriginal
                            ? ` (~${compressEstimate.percentOfOriginal}% of original size)`
                            : ""}
                        </>
                      ) : null}
                      {compressEstimate.growthPercent > 0 ? (
                        <> · ~{compressEstimate.growthPercent}% larger possible (lower CRF)</>
                      ) : null}
                    </span>
                  </div>
                  <div className="estimate-block">
                    <span className="estimate-label">Estimated visual quality loss</span>
                    <strong className="estimate-value">~{compressEstimate.qualityReductionPercent}%</strong>
                    <span className="estimate-muted">
                      ~{compressEstimate.qualityRetainedPercent}% vs a near-lossless reference (heuristic from CRF and
                      preset)
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="field-grid single-column">
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={Boolean(compress.convertFormat)}
                  onChange={(event) => setCompressConvertFormat(event.target.checked)}
                />
                <span>Convert container while compressing (for example MOV → MP4)</span>
              </label>
              {compress.convertFormat ? (
                <label className="field">
                  <span>Target format</span>
                  <select
                    value={compress.targetFormat}
                    onChange={(event) => setCompressTargetFormat(event.target.value)}
                  >
                    {TARGET_FORMAT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field">
                <span>Output file name</span>
                <input
                  value={compress.outputName}
                  onChange={(event) => updateCompressField("outputName", event.target.value)}
                  placeholder="compressed.mp4"
                />
              </label>
              <label className="field">
                <span>CRF (quality)</span>
                <input
                  type="number"
                  value={compress.crf}
                  onChange={(event) => updateCompressField("crf", event.target.value)}
                />
              </label>
              <label className="field">
                <span>Preset</span>
                <select
                  value={compress.preset}
                  onChange={(event) => updateCompressField("preset", event.target.value)}
                >
                  {PRESET_OPTIONS.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Audio bitrate</span>
                <input
                  value={compress.audioBitrate}
                  onChange={(event) => updateCompressField("audioBitrate", event.target.value)}
                />
              </label>
            </div>
          </article>
        </section>

        <aside className="stack">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Runtime</p>
                <h2>Job Logs</h2>
              </div>
            </div>

            {serverMessage ? <p className="error-banner">{serverMessage}</p> : null}
            <pre className="log-panel">
              {jobLogs.length ? jobLogs.join("\n") : "Logs appear here after you start compression."}
            </pre>
          </article>
        </aside>
      </main>
      )}
    </div>
  );
}

function ClipCard({
  clip,
  index,
  maxPreviewBytes,
  setVideoRef,
  onMetadata,
  onTimeUpdate,
  onMove,
  onDuplicate,
  onRemove,
  onFieldChange,
  onSliderChange,
  onSetRangeFromPlayer,
  onSeek,
  onResetCut
}) {
  const durationSeconds = clip.durationSeconds || 0;
  const selectionStart = getEffectiveStartSeconds(clip);
  const selectionEnd = getEffectiveEndSeconds(clip);
  const playhead = clampSeconds(clip.currentTime || 0, 0, durationSeconds || 0);
  const startPercent = durationSeconds ? (selectionStart / durationSeconds) * 100 : 0;
  const endPercent = durationSeconds ? (selectionEnd / durationSeconds) * 100 : 0;
  const playheadPercent = durationSeconds ? (playhead / durationSeconds) * 100 : 0;
  const skipHeavyPreview =
    typeof maxPreviewBytes === "number" && clip.file && clip.file.size > maxPreviewBytes;

  return (
    <div className="clip-card">
      <div className="clip-toolbar">
        <div>
          <strong>Clip {index + 1}</strong>
          <p className="clip-meta">
            {clip.file.name} · {formatBytes(clip.file.size)}
          </p>
        </div>
        <div className="clip-actions">
          <button type="button" className="ghost-button" onClick={() => onMove(index, -1)}>
            Up
          </button>
          <button type="button" className="ghost-button" onClick={() => onMove(index, 1)}>
            Down
          </button>
          <button type="button" className="ghost-button" onClick={() => onDuplicate(index)}>
            Duplicate
          </button>
          <button type="button" className="ghost-button" onClick={() => onRemove(index)}>
            Remove
          </button>
        </div>
      </div>

      <div className="clip-preview">
        {skipHeavyPreview ? (
          <div className="preview-disabled-notice">
            <strong>Preview disabled ({formatBytes(clip.file.size)})</strong>
            <p>
              In-browser playback is turned off for very large files to avoid Chrome crashes. Use Start / End /
              Duration fields below, or split the file into smaller parts.
            </p>
          </div>
        ) : (
          <video
            ref={(node) => setVideoRef(clip.id, node)}
            className="clip-video"
            src={clip.previewUrl}
            controls
            playsInline
            preload="none"
            onLoadedMetadata={(event) => onMetadata(index, event)}
            onTimeUpdate={(event) => onTimeUpdate(index, event)}
            onSeeked={(event) => onTimeUpdate(index, event)}
          />
        )}

        <div className="timeline-summary">
          <span>
            Selected: {formatTimelineTime(selectionStart)} to {formatTimelineTime(selectionEnd)}
          </span>
          <span>
            Playhead: {formatTimelineTime(playhead)}
            {durationSeconds ? ` / ${formatTimelineTime(durationSeconds)}` : ""}
          </span>
        </div>

        {durationSeconds ? (
          <>
            <div className="trim-visual">
              <div
                className="trim-selection"
                style={{
                  left: `${startPercent}%`,
                  width: `${Math.max(endPercent - startPercent, 0)}%`
                }}
              />
              <div className="trim-playhead" style={{ left: `${playheadPercent}%` }} />
            </div>

            <div className="range-grid">
              <label className="range-field">
                <span>Start slider</span>
                <input
                  type="range"
                  min="0"
                  max={durationSeconds}
                  step="0.05"
                  value={Math.min(selectionStart, Math.max(selectionEnd - MIN_TRIM_GAP, 0))}
                  onChange={(event) => onSliderChange(index, "start", event.target.value)}
                />
              </label>
              <label className="range-field">
                <span>End slider</span>
                <input
                  type="range"
                  min="0"
                  max={durationSeconds}
                  step="0.05"
                  value={Math.max(selectionEnd, selectionStart)}
                  onChange={(event) => onSliderChange(index, "end", event.target.value)}
                />
              </label>
            </div>

            <div className="clip-shortcuts">
              <button type="button" className="secondary-button" onClick={() => onSetRangeFromPlayer(index, "start")}>
                Set Start From Player
              </button>
              <button type="button" className="secondary-button" onClick={() => onSetRangeFromPlayer(index, "end")}>
                Set End From Player
              </button>
              <button type="button" className="ghost-button" onClick={() => onSeek(index, selectionStart)}>
                Go To Start
              </button>
              <button type="button" className="ghost-button" onClick={() => onSeek(index, selectionEnd)}>
                Go To End
              </button>
              <button type="button" className="ghost-button" onClick={() => onResetCut(index)}>
                Reset Cut
              </button>
            </div>
          </>
        ) : (
          <p className="clip-meta">
            {skipHeavyPreview
              ? "No timeline preview without in-browser video — use Start / End / Duration fields."
              : "Loading duration…"}
          </p>
        )}
      </div>

      <div className="field-grid">
        <label className="field clip-path">
          <span>Video name</span>
          <input value={clip.file.name} readOnly />
        </label>
        <label className="field">
          <span>Start</span>
          <input
            value={clip.start}
            onChange={(event) => onFieldChange(index, "start", event.target.value)}
            placeholder="00:00:03.500"
          />
        </label>
        <label className="field">
          <span>End</span>
          <input
            value={clip.end}
            onChange={(event) => onFieldChange(index, "end", event.target.value)}
            placeholder="00:00:09.000"
          />
        </label>
        <label className="field">
          <span>Duration</span>
          <input
            value={clip.duration}
            onChange={(event) => onFieldChange(index, "duration", event.target.value)}
            placeholder="5.5"
          />
        </label>
        <label className="toggle-field">
          <input
            type="checkbox"
            checked={Boolean(clip.removeAudio)}
            onChange={(event) => onFieldChange(index, "removeAudio", event.target.checked)}
          />
          <span>Mute only this clip</span>
        </label>
      </div>
    </div>
  );
}

function createEmptyJob() {
  return createJobFromDefaults({
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
  });
}

function createJobFromDefaults(defaults) {
  return {
    outputName: defaults.outputName || "merged-video.mp4",
    removeAudio: Boolean(defaults.removeAudio),
    video: {
      width: defaults.video?.width ?? 1280,
      height: defaults.video?.height ?? 720,
      fps: defaults.video?.fps ?? 30,
      crf: defaults.video?.crf ?? 20,
      preset: defaults.video?.preset ?? "medium"
    },
    audio: {
      bitrate: defaults.audio?.bitrate ?? "192k",
      sampleRate: defaults.audio?.sampleRate ?? 48000
    },
    clips: []
  };
}

function createClipFromFile(file, overrides = {}) {
  return {
    id: createClipId(),
    file,
    previewUrl: URL.createObjectURL(file),
    start: "",
    end: "",
    duration: "",
    removeAudio: false,
    durationSeconds: 0,
    currentTime: 0,
    ...overrides
  };
}

function createClipId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function destroyClipResources(clips) {
  for (const clip of clips || []) {
    if (clip?.previewUrl) {
      URL.revokeObjectURL(clip.previewUrl);
    }
  }
}

function applyClipFieldUpdate(clip, field, value) {
  const nextClip = {
    ...clip,
    [field]: value
  };

  if (field === "end" && String(value).trim() !== "") {
    nextClip.duration = "";
  }

  if (field === "duration" && String(value).trim() !== "") {
    nextClip.end = "";
  }

  return normalizeClipAfterMetadata(nextClip);
}

function normalizeClipAfterMetadata(clip) {
  if (!clip.durationSeconds) {
    return clip;
  }

  return {
    ...clip,
    currentTime: clampSeconds(clip.currentTime || 0, 0, clip.durationSeconds)
  };
}

function applyVisualRange(clip, nextStart, nextEnd) {
  const maxValue = clip.durationSeconds || Math.max(nextStart || 0, nextEnd || 0);
  if (!maxValue) {
    return clip;
  }

  let start = clampSeconds(nextStart, 0, maxValue);
  let end = clampSeconds(nextEnd, 0, maxValue);

  if (end < start) {
    [start, end] = [end, start];
  }

  if (end - start < MIN_TRIM_GAP) {
    if (end + MIN_TRIM_GAP <= maxValue) {
      end += MIN_TRIM_GAP;
    } else {
      start = Math.max(0, end - MIN_TRIM_GAP);
    }
  }

  return {
    ...clip,
    start: start > 0 ? formatTimeInput(start) : "",
    end: Math.abs(end - maxValue) < MIN_TRIM_GAP ? "" : formatTimeInput(end),
    duration: ""
  };
}

function getEffectiveStartSeconds(clip) {
  return clampSeconds(parseTimeInput(clip.start) ?? 0, 0, clip.durationSeconds || Number.MAX_SAFE_INTEGER);
}

function getEffectiveEndSeconds(clip) {
  const start = getEffectiveStartSeconds(clip);
  const maxValue = clip.durationSeconds || Number.MAX_SAFE_INTEGER;
  const durationValue = parseTimeInput(clip.duration);

  if (durationValue != null) {
    return clampSeconds(start + durationValue, start, maxValue);
  }

  const endValue = parseTimeInput(clip.end);
  if (endValue != null) {
    return clampSeconds(endValue, start, maxValue);
  }

  if (clip.durationSeconds) {
    return clip.durationSeconds;
  }

  return start;
}

function prepareUploadJob(job) {
  return cleanObject({
    outputName: normalizeField(job.outputName),
    removeAudio: Boolean(job.removeAudio),
    video: {
      width: normalizeField(job.video.width),
      height: normalizeField(job.video.height),
      fps: normalizeField(job.video.fps),
      crf: normalizeField(job.video.crf),
      preset: normalizeField(job.video.preset)
    },
    audio: {
      bitrate: normalizeField(job.audio.bitrate),
      sampleRate: normalizeField(job.audio.sampleRate)
    },
    clips: job.clips.map((clip) =>
      cleanObject({
        start: normalizeField(clip.start),
        end: normalizeField(clip.end),
        duration: normalizeField(clip.duration),
        removeAudio: Boolean(clip.removeAudio)
      })
    )
  });
}

function normalizeField(value) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanObject(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(entries);
}

function parseTimeInput(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const normalized = parts.map((part) => Number(part));
  if (normalized.some((part) => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 2) {
    return normalized[0] * 60 + normalized[1];
  }

  return normalized[0] * 3600 + normalized[1] * 60 + normalized[2];
}

function formatTimeInput(seconds) {
  return Number(seconds).toFixed(3);
}

function formatTimelineTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "00:00.000";
  }

  const total = Math.max(seconds, 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
}

function clampSeconds(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function isVideoFile(file) {
  return (
    file.type.startsWith("video/") ||
    [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"].some((extension) =>
      file.name.toLowerCase().endsWith(extension)
    )
  );
}

function getVideoExtension(filename) {
  const lower = String(filename).toLowerCase();
  const match = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"].find((extension) => lower.endsWith(extension));
  return match || "";
}

function buildDefaultCompressOutputName(filename, convertFormat, targetFormat) {
  const token = String(targetFormat || "mp4")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  const targetExt = `.${token}`;

  if (convertFormat) {
    return `compressed${targetExt}`;
  }

  const inputExt = getVideoExtension(filename);
  if (inputExt) {
    return `compressed${inputExt}`;
  }

  return `compressed${targetExt}`;
}

function createDefaultCompressState() {
  return {
    file: null,
    previewUrl: "",
    outputName: "compressed.mp4",
    crf: 23,
    preset: "medium",
    audioBitrate: "128k",
    convertFormat: false,
    targetFormat: "mp4"
  };
}

async function readJsonResponseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function uploadCompressInChunks(file, metadata, onProgress) {
  const initResponse = await fetch("/api/jobs/compress-stream/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalName: file.name,
      totalBytes: file.size,
      metadata
    })
  });
  const initBody = await readJsonResponseBody(initResponse);

  if (!initResponse.ok) {
    throw new Error(initBody.error || "Could not start chunked upload.");
  }

  const jobId = initBody.jobId;
  const chunkSize = initBody.chunkSizeBytes || 16 * 1024 * 1024;
  let offset = 0;
  let chunkIndex = 0;

  onProgress?.(0);

  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    const slice = file.slice(offset, end);
    const chunkResponse = await fetch(`/api/jobs/compress-stream/${jobId}/chunk`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Chunk-Index": String(chunkIndex)
      },
      body: slice
    });
    const chunkBody = await readJsonResponseBody(chunkResponse);

    if (!chunkResponse.ok) {
      throw new Error(chunkBody.error || `Upload chunk ${chunkIndex} failed.`);
    }

    offset = end;
    chunkIndex += 1;
    onProgress?.(Math.min(100, Math.round((offset / file.size) * 100)));
  }

  const finalizeResponse = await fetch(`/api/jobs/compress-stream/${jobId}/finalize`, {
    method: "POST"
  });
  const finalizeBody = await readJsonResponseBody(finalizeResponse);

  if (!finalizeResponse.ok) {
    throw new Error(finalizeBody.error || "Could not finalize upload.");
  }

  return finalizeBody;
}

function postFormDataWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.onerror = () => {
      reject(new Error("Network error"));
    };

    xhr.onload = () => {
      let body = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }

      reject(new Error(body.error || `Request failed (${xhr.status})`));
    };

    xhr.send(formData);
  });
}

function isVideoPreviewTooHeavy(file) {
  return Boolean(file && file.size > MAX_BROWSER_VIDEO_PREVIEW_BYTES);
}

function isFileTooLargeForBrowserUpload(file) {
  return Boolean(file && file.size > MAX_BROWSER_SINGLE_UPLOAD_BYTES);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
