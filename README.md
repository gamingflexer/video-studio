# Video Studio — grade, review the cut, hand back to Claude Code

A small local web app for editing video together with Claude Code. Claude cuts the film; you open it here to
grade it (LUTs + curves), see and move the cuts, leave notes, render, and send the review back as one prompt.
It runs entirely on your Mac at http://localhost:3210 and uses ffmpeg for everything it renders.

**New Mac?** Follow [setup.md](setup.md) — one command installs everything (no Homebrew needed) and adds a
"Video Studio" app you can open from Spotlight.

Already have Node 20+, pnpm and ffmpeg:

```bash
pnpm install
pnpm dev        # http://localhost:3210
```

## The video folder (workspace)

Everything about your videos lives in one folder, separate from this app: `new-media/`, `videos/`,
`newly transferred videos and B-rolls/` and `luts/`. On first start the app asks for it (or the setup script
creates `~/Movies/Video Studio`); the choice is stored in `~/.video-studio/config.json`
(`STUDIO_WORKSPACE=/path` overrides it). If this repo is placed *inside* an existing workspace (a folder with
`start.md` and `videos/`), that folder is used automatically.

Each video has its own link: `/p/<id>` (the `id` in its `edit.json`). The home page lists every `edit.json`
found in the workspace and has a Finder-style browser over the three media folders (↑ ↓ move, → or ⏎ open a
folder, ← back, ⏎ on a video opens it; type to jump). Opening a loose video makes a one-source project with
cuts guessed by scene detection (kept in `projects/` inside this app).

## What it does

| Area | What you get |
|---|---|
| Monitor | **Cut** = your timeline played live from the source clips with the grade applied in WebGL · **Render** = any file in the project's `renders/` · **Source** = raw footage (click a source lane). Grade on/off (G), Before \| After wipe with a draggable line (double-click it to centre). |
| Colour | Node order copied from the reference reels: **1 primaries** (exposure, contrast, saturation, temperature, tint) → **2 LUT at an intensity** (default 60 %) → **3 curves** (master / R / G / B, with the frame's histogram) → **4 vignette**. Grade the whole film or one shot only. |
| LUT library | `<workspace>/luts/` (`index.json` + clean `.cube` files, usable from ffmpeg, Resolve and Premiere). Upload `.cube`, `.3dl`, Hald `.png`, `.dat`, `.m3d`, `.csp` or a `.zip`; everything is converted to `.cube`. "As new LUT" bakes the current grade into a new cube; "As look" saves the editable settings (`<workspace>/luts/looks/`). |
| Timeline | "Claude's cut" (from `edit.json`) above "Your cut". Drag blocks to reorder, edges to trim, **S** splits, **⌫** removes, **⌘Z** undoes. Source lanes show every take: bright = used, dim = left out; drag a bright piece to slip it, double-click dim footage to add a shot. Every change asks for an optional note. |
| Shot inspector | **Double-click** a shot (or select it and press ⏎, or **right-click** → menu) to see why Claude cut it that way, the shot as data (`edit.json` vs your version), the matching line in the build script, and the equivalent ffmpeg call — plus a comment box with **Send this shot to Claude Code** (one-shot prompt; the rest of the review is not sent). The right-click menu also has: grade only this shot, split, back to Claude's cut, remove. |
| Render | Preview / Final / 4K / ProRes master, with or without the grade. "Cut from sources" = straight cuts + grade + audio bed. "Regrade a render" = put the grade on a finished (ideally `nograde`) render. |
| Send to Claude Code | Saves `edit.review.json`, bakes `grade/studio-grade.cube` (+ one per graded shot), writes `STUDIO_HANDOFF.md` and copies the prompt. |

## Shortcuts (Premiere-style, deliberately few)

| Key | Does |
|---|---|
| Space · K / L | play / stop · stop / play |
| ← → · ⇧← ⇧→ | one frame · ten frames |
| ↑ ↓ | previous / next cut |
| ⌘K (also ⌘B, S) | cut the shot at the playhead |
| Q · W | trim the start / the end of the shot to the playhead |
| R | rename the shot |
| ⏎ | shot details (reasoning, code, comment, send) |
| ⌫ | remove the selected shot |
| G | grade on / off |
| ⌘Z · ⇧⌘Z | undo · redo (also the ↶ ↷ buttons at the top) |

The **Shortcuts** button under the monitor (or `?`) shows this list. Light / dark mode is the button at the top right (the monitor and the curve graph stay dark in both).

## Files per video

```
<project>/edit.json          written by Claude with every cut — sources, shots (in/out/speed/crop/note), fps, size, audio bed
<project>/edit.review.json   written by the Studio — your version of the shots, comments, grade (autosaved)
<project>/grade/*.cube       the approved look, baked (33-point) — apply with lut3d=file=…:interp=tetrahedral
<project>/STUDIO_HANDOFF.md  the last prompt sent
```

Schema: `lib/types.ts` (`EditDoc`, `Shot`, `Grade`, `Review`).

## The reasoning Claude saves (and where you see it)

`edit.json` carries the "why" as well as the cut, and the Studio surfaces it:

| Field | Meaning | Shown |
|---|---|---|
| `shots[].note` | why this take, and why it starts and ends exactly there | "Why this cut" under the monitor as the film plays · shot tooltip · Cut & notes · inspector |
| `shots[].considered` | what else was tried for that slot and why it lost | Cut & notes · inspector |
| `sources[].note` | what a take is; for unused takes, why it was left out | "Takes left out" in Cut & notes · source-lane tooltip |
| `reasoning` | the thinking behind the whole cut | top of Cut & notes |

## How the colour stays honest

The whole grade (primaries → LUT mix → curves) is baked into one 33-point cube by `lib/color.ts`. The monitor samples that cube in a shader and ffmpeg applies the same cube with `lut3d`, so preview and render agree (measured: within ~1/255 on real footage). Only the vignette is outside the cube (shader ↔ ffmpeg `vignette`, same cos⁴ falloff).

Camera originals (4K HEVC) are played through small H.264 proxies kept in `.cache/proxies/` inside this app (safe to delete; rebuilt on demand). Renders always use the originals.

## Limits

- The Studio's own render is straight cuts: no transitions, text, speed ramps or project-specific effects. Those live in each project's build script — that is what "Send to Claude Code" is for.
- HLG/HDR sources are previewed and graded as-is (no tone-mapping), same as the existing ffmpeg pipelines.
- Audio in "Cut from sources" is the project's audio bed only (`edit.json → audio`), not per-clip sound.

## Bundled LUTs and licences

`default-luts/` is copied into a new workspace's `luts/` once:

- **Blockbuster, Golden Hour, Matte Fade, Midnight** — EditorHub Originals, released as CC0 (https://editor-hub.com/assets/luts).
- **Kodak Portra 400** — from the RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra,
  CC BY-SA 4.0 (https://rawpedia.rawtherapee.com/Film_Simulation); converted here from the Hald PNG to a 65-point `.cube`,
  and still CC BY-SA 4.0. The collection's README is `default-luts/LICENCE_RawTherapee-film-simulation.txt`.
- The five **house looks** (Teal & Orange, Print Film Warm, Bleach Bypass, Night Amber, Warm Fade) are generated by
  `lib/houseLuts.ts`.

## Scripts

| | |
|---|---|
| `scripts/setup.sh` | one-step install on a Mac (see `setup.md`) |
| `scripts/make-app.sh` | (re)create `~/Applications/Video Studio.app` |
| `scripts/stop.sh` | stop the background server the app launcher started |
