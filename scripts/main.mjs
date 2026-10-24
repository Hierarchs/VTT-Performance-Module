import {MODULE_ID, log, warn} from "./constants.mjs";
import {HookProfiler} from "./hook-profiler.mjs";
import {registerSettings, registerKeybindings} from "./settings.mjs";
import {FrameLimiter} from "./frame-limiter.mjs";
import {PerfHud} from "./perf-hud.mjs";
import {ScenePreloader} from "./scene-preloader.mjs";
import {OptimizerApp} from "./optimizer-app.mjs";
import {ProfilerApp} from "./profiler-app.mjs";

// Start recording who registers each hook as early as possible, so the profiler can attribute handlers
// registered by every package that loads after this one.
HookProfiler.installAttribution();

/**
 * Run one feature's setup in isolation so a failure in one never takes the others (or the game) down.
 * @param {string} name
 * @param {Function} fn
 */
function safely(name, fn) {
  try {
    fn();
  } catch(err) {
    warn(`Failed to initialize ${name}; it has been disabled for this session.`, err);
  }
}

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();

  // Render fewer chat messages up front; older ones still load when scrolling up.
  CONFIG.ChatMessage.batchSize = game.settings.get(MODULE_ID, "chatBatchSize");

  safely("frame limiter", () => FrameLimiter.initialize());
  safely("scene preloader", () => ScenePreloader.initialize());
  safely("performance HUD", () => PerfHud.initialize());

  game.modules.get(MODULE_ID).api = {
    FrameLimiter,
    HookProfiler,
    PerfHud,
    ScenePreloader,
    openOptimizer: () => new OptimizerApp().render({force: true}),
    openProfiler: () => new ProfilerApp().render({force: true})
  };
  log("Initialized");
});
