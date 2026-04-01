# Video Merge Tool

Local FFmpeg tool with:

- Node.js CLI for config-based jobs
- React frontend for non-technical users
- local API server that handles uploads and output downloads

The browser flow now works without manual file paths.

## Install

```bash
npm install
```

## Non-technical browser flow

Run the app:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

Then:

1. Click `Add Videos` or drag-and-drop video files.
2. Change clip order with `Up` and `Down`.
3. Fill `Start`, `End`, or `Duration` only where needed.
4. Turn on `Mute only this clip` if a single clip audio remove karni ho.
5. Turn on `Remove all audio from final video` if puri final video silent chahiye.
6. Click `Merge Videos`.
7. When processing completes, click `Download Final Video`.

Uploaded source videos are handled by the local server, and the final file is downloaded from the browser.

## Production build

```bash
npm run build
npm start
```

That serves the built frontend and API from:

```text
http://localhost:3001
```

## CLI usage

Generate a sample config:

```bash
npm run init
```

Run a job:

```bash
node ./src/cli.js run ./examples/job.sample.json
```

Or install the CLI globally inside this folder:

```bash
npm link
video-tool run ./examples/job.sample.json
```

## CLI config format

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

- Browser mode does not require entering file system paths.
- CLI mode still supports path-based batch jobs.
- `start`, `end`, and `duration` accept seconds or `HH:MM:SS(.ms)`.
- `removeAudio` on a clip replaces only that clip's audio with silence.
- top-level `removeAudio: true` makes the full output silent.
- all clips are normalized to one output size and FPS before merge so mixed inputs can still be combined.
# vidtent
