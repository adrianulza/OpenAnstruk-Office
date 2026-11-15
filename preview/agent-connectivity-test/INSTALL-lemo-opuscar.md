# Installing lemo-opuscar for the office

Run on your machine (Windows terminal, from any folder):

```
claude plugin marketplace add lemomo-ai/lemo-opuscar
claude plugin install lemo-opuscar@lemolab
```

- First use downloads the library to `~/lemo-opuscar` (shared by all films).
- Needs Node 20+, ffmpeg 7+, Python 3.11+. Your winget ffmpeg (Gyan.FFmpeg) is fine if it is 7 or newer: `ffmpeg -version`.
- Your own adapted styles go to `~/lemo-my-styles/<name>/` and survive updates.
- Do **not** copy its `STYLE.md` files into OpenAnstruk-Studio or video-in-motion: the docs are CC BY-NC 4.0, with an extra permission to use them for your own films (commercial included). The office only stores names, one-liners and links (`templates.json`).

Effort: the library asks for `/effort high`. Inside the office the Director-Animator runs it on Sonnet high, under the $4 guard.

Three styles need an image generator you supply: Comic History Cartoon, Manga Panels, Text Flash Cuts.
