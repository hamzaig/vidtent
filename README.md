# AI Video Generation Workspace

This repository is the working foundation for an AI-assisted video generation pipeline.

Target direction:

- upload and arrange source video clips
- generate AI-written content or narration scripts from a prompt
- convert generated script into AI voice using text-to-speech
- align generated voice with video timing
- let the editor fine-tune clip timing, cuts, and final export

Important:

- the current codebase is still focused on clip upload, visual trimming, reordering, muting, merging, and final export
- AI content generation, AI voice generation, text-to-speech orchestration, and narration-to-video alignment are planned next-stage features
- this README describes both the current base and the intended roadmap

## Product vision

The goal is to turn this project into a practical AI video assembly tool where a user can:

1. upload raw clips
2. provide a topic, prompt, or idea
3. generate AI content for narration or scene guidance
4. generate AI voiceover from that text
5. sync the voiceover with the selected video timeline
6. export a polished final video

This means the project is moving beyond simple merging and toward a full AI-assisted video composition workflow.

## Current foundation

Right now the repository already provides:

- Node.js CLI for FFmpeg-based batch jobs
- local API server for browser uploads and processing
- React frontend for non-technical users
- visual video preview and trimming
- clip ordering, per-clip mute, full-output mute, and export

This current layer is useful because it establishes:

- clip management
- timeline editing basics
- browser upload flow
- final rendering/export flow

These are the pieces the future AI narration pipeline will build on top of.

## Planned AI features

The intended next phase is to add:

- prompt-driven AI script generation
- scene-wise AI content planning
- text-to-speech voice generation
- multiple AI voice styles
- auto-alignment of generated narration with clip timing
- optional subtitle generation from final narration
- optional soundtrack and sound-design layer
- timeline suggestions based on narration length

Suggested high-level future flow:

1. User uploads source clips.
2. User enters a prompt or topic.
3. System generates scene content or narration text.
4. System generates AI voice from that text.
5. System estimates or computes segment durations.
6. System maps narration to video clips.
7. User visually adjusts timing if needed.
8. System renders the final video.

## Current browser workflow

Run the app:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Current browser flow:

1. Upload clips with `Browse Videos` or drag and drop.
2. Preview each clip directly in the browser.
3. Set visual trims with sliders or player-based start/end controls.
4. Reorder clips.
5. Mute individual clips or mute the whole output.
6. Merge and download the final video.

## Production build

```bash
npm run build
npm start
```

Built app runs at:

```text
http://localhost:3001
```

## Current CLI usage

Generate a sample config:

```bash
npm run init
```

Run a job:

```bash
node ./src/cli.js run ./examples/job.sample.json
```

## Current CLI config format

```json
{
  "output": "./output/final.mp4",
  "workingDir": "./.video-tool-temp",
  "removeAudio": false,
  "video": {
    "width": 1280,
    "height": 720,
    "fps": 30,
    "crf": 20,
    "preset": "medium"
  },
  "audio": {
    "bitrate": "192k",
    "sampleRate": 48000
  },
  "clips": [
    {
      "path": "./input/intro.mp4",
      "start": "00:00:02.500",
      "end": "00:00:06.000",
      "removeAudio": true
    },
    {
      "path": "./input/main.mp4",
      "start": 10,
      "duration": 8
    },
    {
      "path": "./input/outro.mp4"
    }
  ]
}
```

## Notes

- Browser mode currently focuses on video upload, preview, trimming, and export.
- CLI mode currently focuses on FFmpeg-driven merging and trimming.
- AI voice, AI script, TTS, and narration alignment are not implemented yet in the repository.
- The existing architecture is intended to serve as the base for those future features.
