# Setting up Video Studio on a Mac

For editors starting from a **new MacBook** (nothing installed — no Homebrew, no Xcode tools, no git).
It takes about five minutes on a normal connection and uses **under 1 GB** of disk (measured: app 367 MB + tools 297 MB),
so it is comfortable on a 256 GB Mac.

## 1. Run one command

Open **Terminal** (⌘Space, type "Terminal", Enter), paste this, press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/gamingflexer/video-studio/main/scripts/setup.sh | bash
```

When it prints **Ready.** the app opens in your browser. From then on, open it like any other app:
**⌘Space → "Video Studio" → Enter** (it lives in `~/Applications`; drag it to the Dock if you like).

That is all most people need. The rest of this page explains what happened and how to fix things.

## 2. What the command installs

Everything is skipped if it is already on the Mac, and nothing needs an administrator password
(except Rosetta, see below).

| Step | What | Where | Size |
|---|---|---|---|
| 1 | The app (this repo, downloaded as a tarball — git is not needed) | `~/VideoStudio` | ~370 MB with its packages and build |
| 2 | Node.js 22 (official build from nodejs.org, checksum verified) | `~/.video-studio/node` | ~120 MB |
| 3 | pnpm (the package manager) | `~/.video-studio/tools` | ~15 MB |
| 4 | ffmpeg + ffprobe (static build from evermeet.cx, the macOS build ffmpeg.org links to) | `~/.video-studio/bin` | ~160 MB |
| 5 | The app's packages, and a production build | inside `~/VideoStudio` | (counted in 1) |
| 6 | Your **video folder** with `new-media/`, `videos/`, `newly transferred videos and B-rolls/`, `luts/` | `~/Movies/Video Studio` | empty |
| 7 | **Video Studio.app** with its icon | `~/Applications` | tiny |

**Apple-silicon Macs (M1 and later):** the ffmpeg build in step 4 is an Intel program and runs through Rosetta.
If Rosetta is not installed yet, the script installs it (macOS may ask for your password once).
If you already use Homebrew, `brew install ffmpeg` *before* running the command gives a native, somewhat faster ffmpeg —
the script uses whatever ffmpeg it finds first.

## 3. The video folder

Put footage in `~/Movies/Video Studio/new-media` (or `newly transferred videos and B-rolls`) and project folders in
`videos/`. The home page of the app browses these like Finder.

To use a different folder (an existing editing folder, an external drive):

```bash
STUDIO_WORKSPACE="/Volumes/Work/Video Editing" bash ~/VideoStudio/scripts/setup.sh
```

or edit `~/.video-studio/config.json`. If the app is opened before any folder is set, it asks:
"Use the standard folder" or "Choose a folder…".

## 4. Everyday use

- **Open:** ⌘Space → "Video Studio". The first click after a restart takes a few seconds while the server starts.
- **Stop the background server** (optional; it uses very little while idle):

```bash
bash ~/VideoStudio/scripts/stop.sh
```

- **Update to the newest version:** run the command from step 1 again. Your video folder, LUTs and opened projects are kept.
- **Remove everything:** delete `~/VideoStudio`, `~/.video-studio` and `~/Applications/Video Studio.app`.
  Your video folder is yours — it is never deleted.

## 5. If something goes wrong

| You see | Do this |
|---|---|
| "Video Studio could not start" | Open `~/.video-studio/server.log` (the alert names it). Usually re-running step 1 fixes it. |
| "ffmpeg did not install correctly" | Install Homebrew from https://brew.sh, run `brew install ffmpeg`, then run step 1 again. |
| The page does not load | Something else is using port 3210, or the server stopped: run `bash ~/VideoStudio/scripts/stop.sh`, then open the app again. |
| The monitor is black for HEVC / HDR phone clips | Wait for "Preparing proxies" at the top to finish; the app makes small preview copies first. |
| Clipboard copy is blocked | Use the **Copy prompt** button, or select the text in the box and press ⌘C. |

## 6. For a Claude Code session doing this setup

If you are Claude Code and were asked to set this Mac up:

1. Run the command in step 1 in the terminal. Do not install Homebrew or Xcode tools unless a step fails and the table in
   step 5 says so.
2. Check the result: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3210` should print `200` after
   `open ~/Applications/"Video Studio.app"`; `~/.video-studio/config.json` should name the video folder.
3. Tell the editor where the video folder is and that the app is in Spotlight as "Video Studio".
4. If the editor already has an editing folder, re-run with `STUDIO_WORKSPACE=<that folder>` instead of asking them to move files.

## What was tested

The whole script was run on macOS (Apple silicon) with an empty home folder and a bare `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), which is what a new Mac looks like: Node, pnpm and ffmpeg were downloaded, the app
built, the folder and the app icon were created, and the installed copy imported a video, made a proxy, rendered a graded
preview and produced a hand-off prompt. Not tested: an Intel Mac, and a Mac where Rosetta is missing.
