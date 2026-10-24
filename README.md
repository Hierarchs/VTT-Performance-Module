# Performance Overhaul

A Foundry VTT module that makes the client lighter on your hardware and shows you where the time goes.

Built for **Foundry VTT v14** against the published v14 API. Every feature is client-side, and each one can be
switched off on its own in **Configure Settings → Module Settings**.

## What it does

### Adaptive frame limiter
Foundry renders the canvas at your full frame cap (usually 60 FPS) all the time, even when you are reading a
sheet, typing in chat, or tabbed out to Discord. Animated lights alone keep the GPU busy every frame.

- **Idle:** after 5 seconds without canvas input, the canvas drops to 20 FPS.
- **Background:** while the Foundry window is unfocused or hidden, it drops to 10 FPS.
- **Instant wake:** mouse or wheel input over the map, or keyboard input outside text fields, restores full
  speed immediately. So does any canvas animation (token movement, panning, pings, scrolling text),
  including animations started by other players, so you always see movement at full smoothness.
- **Video aware:** while a video map or tile plays, the cap never goes below 30 FPS.

While idle, the canvas renders a third as many frames as before (20 instead of 60). In the background it
renders a sixth. How much that saves overall depends on how much of your session is spent away from the map.

It uses the same lever as core's Maximum Framerate setting, the PIXI ticker frame cap, so it doesn't replace
any rendering code.

### Background scene preloading
After a scene loads, the textures for the two nearest scenes in the navigation bar (the active scene first)
load quietly in the background, one scene and one file at a time. Switching to them then skips the
download. It goes through core's own scene texture loader, so it loads exactly what core would, Levels
included, but without the progress bar and without evicting anything already cached. Videos are skipped by
default.

### Faster world load
The chat log renders 30 messages at a time instead of core's default batch. Older messages still load as you
scroll up.

### Hook Profiler
**Module Settings → Hook Profiler → Open Profiler**, press Start, play for a minute or two, press Stop.

You get:

- the main-thread time spent in hook handlers, grouped by **module, system, world script, and core**
- the slowest individual handlers
- the slowest window renders, such as character sheets

Rows in red had at least one call long enough to drop a frame. **Copy Report** puts a plain-text summary on
your clipboard for sharing.

Attribution comes from the call stack when each handler is registered. Handlers registered by modules that
load before this one are attributed by looking for their package id in the handler's code; those rows are
marked with a **?**. Before every session the profiler checks that it can actually intercept hook handlers on
your Foundry version, and refuses to start (with a console message) if it can't.

### Optimizer and Health Report
**Module Settings → Optimizer & Health Report** checks this client and the current scene for:

- software rendering (no hardware acceleration) or WebGL 1
- high-DPI rendering, with the estimated GPU saving from turning it off
- oversized map images, and PNG maps that would be much smaller as WebP
- animated lights, wall and token counts, and video tiles
- texture cache size
- a chat log large enough to slow down world load
- live token drag preview

It also offers three presets, **Quality**, **Balanced**, and **Performance**. A preset changes client
settings for this browser only, shows you exactly what will change, and then reloads. Core settings that
your Foundry version doesn't have are skipped.

### Performance HUD
**Ctrl+Shift+P** toggles a small, draggable overlay showing:

- rendered FPS against the current cap, and the limiter mode
- CPU time per frame
- main-thread stalls in the last 10 seconds
- JS and texture memory
- DOM size and canvas object counts
- scene preloading progress

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Adaptive Frame Limiter | On | |
| Idle Frame Rate | 20 | PIXI can't throttle below 10 |
| Idle After (Seconds) | 5 | |
| Background Frame Rate | 10 | Raise to your max FPS if you stream the canvas |
| Keep Video Smooth | On | 30 FPS floor while video plays |
| Chat Messages per Batch | 30 | Requires reload |
| Preload Upcoming Scenes | 2 | 0 disables |
| Preload Video Files | Off | |
| Show Performance HUD | Off | Ctrl+Shift+P |

## Installing

### From a release (recommended)
Once a release has been published on this repository, paste this manifest URL into **Add-on Modules → Install
Module → Manifest URL**:

```
https://github.com/Hierarchs/VTT-Performance-Module/releases/latest/download/module.json
```

### Manually
Download this repository as a zip and extract it into your Foundry data folder's `Data/modules` directory.
Then rename the extracted folder to `performance-overhaul`, which must match the module id. Restart Foundry
and enable **Performance Overhaul** in **Manage Modules**.

libWrapper is optional. When it's active, Performance Overhaul registers its one permanent patch
(`CanvasAnimation.animate`) through it.

## Publishing a release

Push a version tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow in `.github/workflows/release.yml` then:

1. stamps that version and the release URLs into `module.json`
2. builds `module.zip`
3. creates the GitHub release with both files attached

Publishing a release from the GitHub website with a new version tag works too; the workflow attaches the
files to it. Either way, the manifest URL above then serves the newest release.

## Things to know

- Idle and background throttling make animated lights, weather, and remote cursors less smooth while you
  aren't interacting with the map. That's the trade-off; raise the idle rate if it bothers you.
- The profiler measures synchronous work only. Work a handler starts asynchronously isn't counted.
- Window render times are wall-clock times and include waiting for data and templates.
- The API is available at `game.modules.get("performance-overhaul").api`.
