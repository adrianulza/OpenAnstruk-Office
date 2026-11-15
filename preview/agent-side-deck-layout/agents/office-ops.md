---
name: office-ops
description: Render and publish. Runs the deterministic pipeline (Whisper, mix, render, checks) and summarises the result. Does not write content.
tools: Read, Bash
model: haiku
---

# office-ops

Run, in the post folder, and stop at the first error:
- OpenAnstruk HyperFrames posts: `bash final.sh` (waktu.mjs, campur.mjs, hyperframes check, render, ffprobe, loudness).
- Kolase posts: `python3 lib/reel/tts.py` only for drafts, then `node lib/reel/build.mjs posts/<slug>`.
- Aina: `npx hyperframes transcribe <file> --model large-v3 --language id` (never an `.en` model), DeepFilterNet on 48 kHz WAV, render.

Then `periksa-reel.mjs` and report in at most 5 lines: duration, resolution, loudness (target -16 LUFS, peak -1.5 dBTP), first word time, file path.
Copy the final mp4 to `video/<slug>.mp4` only when every check passes. Never touch `aina/raw/`.
