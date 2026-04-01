import { startTransition, useEffect, useRef, useState } from "react";

const PRESET_OPTIONS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"];
const MIN_TRIM_GAP = 0.05;

export default function App() {
  const fileInputRef = useRef(null);
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
      setServerMessage("Pehle videos upload karein.");
      return;
    }

    setServerMessage("");
    setJobStatus("submitting");
    setJobLogs([]);
    setDownloadUrl("");

    try {
      const formData = new FormData();
      formData.append("metadata", JSON.stringify(prepareUploadJob(job)));

      for (const clip of job.clips) {
        formData.append("clipFiles", clip.file, clip.file.name);
      }

      const response = await fetch("/api/jobs/upload", {
        method: "POST",
        body: formData
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Merge job start nahi ho saka.");
      }

      setJobId(data.jobId);
      setJobStatus("queued");
    } catch (error) {
      setJobStatus("failed");
      setServerMessage(error.message);
    }
  }

  function handleFilesSelected(fileList) {
    const nextClips = Array.from(fileList || [])
      .filter((file) => isVideoFile(file))
      .map((file) => createClipFromFile(file));

    if (!nextClips.length) {
      setServerMessage("Sirf video files select karein.");
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

        startTransition(() => {
          setJob(createJobFromDefaults(data.browserDefaults));
          setJobId(null);
          setJobStatus("idle");
          setJobLogs([]);
          setDownloadUrl("");
          setServerMessage("");
        });
      })
      .catch((error) => {
        setServerMessage(error.message);
      });
  }

  const totalDurationHint = `${job.clips.length} clip${job.clips.length === 1 ? "" : "s"} ready`;

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy-wrap">
          <p className="eyebrow">No Technical Setup Needed</p>
          <h1>Upload Videos. Arrange. Merge.</h1>
          <p className="hero-copy">
            Har clip ka video yahin dikhega. Player se frame dekh kar start aur end set kar sakte
            hain, ya timeline sliders se visual cut kar sakte hain.
          </p>
        </div>

        <div className="status-panel">
          <span className={`status-pill status-${jobStatus}`}>{jobStatus}</span>
          <p>{downloadUrl ? "Final video ready hai. Download button use karein." : totalDurationHint}</p>
          <div className="hero-actions">
            <button type="button" className="primary-button" onClick={handleRunJob}>
              Merge Videos
            </button>
            <button type="button" className="secondary-button" onClick={openFilePicker}>
              Browse Videos
            </button>
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
              <strong>Videos ko yahan drag and drop karein</strong>
              <p>ya Browse button se files choose karein</p>
              <button type="button" className="dropzone-button" onClick={openFilePicker}>
                Browse Files
              </button>
            </div>

            <div className="quick-notes">
              <p>System har uploaded file ko ek clip samjhega.</p>
              <p>Player se current frame par ja kar start aur end set kiya ja sakta hai.</p>
            </div>
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Step 2</p>
                <h2>Visual Clip Trimming</h2>
              </div>
            </div>

            <div className="clip-stack">
              {job.clips.length ? (
                job.clips.map((clip, index) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    index={index}
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
                  <strong>Abhi koi video upload nahi hui.</strong>
                  <p>Browse Videos button ya drag and drop use karein.</p>
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
                <h2>Final Output</h2>
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
                <span>Remove all audio from final video</span>
              </label>
            </div>
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
            <pre className="log-panel">{jobLogs.length ? jobLogs.join("\n") : "Merge start karne ke baad logs yahan aayenge."}</pre>
          </article>
        </aside>
      </main>
    </div>
  );
}

function ClipCard({
  clip,
  index,
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
        <video
          ref={(node) => setVideoRef(clip.id, node)}
          className="clip-video"
          src={clip.previewUrl}
          controls
          preload="metadata"
          onLoadedMetadata={(event) => onMetadata(index, event)}
          onTimeUpdate={(event) => onTimeUpdate(index, event)}
          onSeeked={(event) => onTimeUpdate(index, event)}
        />

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
          <p className="clip-meta">Video duration load ho rahi hai...</p>
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
