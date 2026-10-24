import {MODULE_ID} from "./constants.mjs";
import {FrameLimiter} from "./frame-limiter.mjs";
import {PerfHud} from "./perf-hud.mjs";
import {OptimizerApp} from "./optimizer-app.mjs";
import {ProfilerApp} from "./profiler-app.mjs";

/**
 * Register a client-scoped setting with localized name and hint keys derived from its key.
 * @param {string} key
 * @param {object} data
 */
function register(key, data) {
  game.settings.register(MODULE_ID, key, {
    name: `PERFOVERHAUL.Settings.${key}.Name`,
    hint: `PERFOVERHAUL.Settings.${key}.Hint`,
    scope: "client",
    config: true,
    ...data
  });
}

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "optimizer", {
    name: "PERFOVERHAUL.Optimizer.MenuName",
    label: "PERFOVERHAUL.Optimizer.MenuLabel",
    hint: "PERFOVERHAUL.Optimizer.MenuHint",
    icon: "fa-solid fa-gauge-high",
    type: OptimizerApp,
    restricted: false
  });

  game.settings.registerMenu(MODULE_ID, "profiler", {
    name: "PERFOVERHAUL.Profiler.MenuName",
    label: "PERFOVERHAUL.Profiler.MenuLabel",
    hint: "PERFOVERHAUL.Profiler.MenuHint",
    icon: "fa-solid fa-stopwatch",
    type: ProfilerApp,
    restricted: false
  });

  const reevaluate = () => FrameLimiter.evaluate();

  // Adaptive frame limiter
  register("limiterEnabled", {type: Boolean, default: true, onChange: reevaluate});
  register("idleFPS", {type: Number, default: 20, range: {min: 10, max: 60, step: 5}, onChange: reevaluate});
  register("idleDelay", {type: Number, default: 5, range: {min: 1, max: 60, step: 1}, onChange: reevaluate});
  register("backgroundFPS", {type: Number, default: 10, range: {min: 10, max: 60, step: 5}, onChange: reevaluate});
  register("smoothVideo", {type: Boolean, default: true, onChange: reevaluate});

  // World load
  register("chatBatchSize", {type: Number, default: 30, range: {min: 10, max: 100, step: 5}, requiresReload: true});

  // Scene preloading
  register("preloadScenes", {type: Number, default: 2, range: {min: 0, max: 5, step: 1}});
  register("preloadVideos", {type: Boolean, default: false});

  // Performance HUD
  register("hudEnabled", {type: Boolean, default: false, onChange: enabled => PerfHud.toggle(enabled)});
  game.settings.register(MODULE_ID, "hudPosition", {scope: "client", config: false, type: Object, default: {}});
}

export function registerKeybindings() {
  const {CONTROL = "Control", SHIFT = "Shift"} = foundry.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS ?? {};
  game.keybindings.register(MODULE_ID, "toggleHud", {
    name: "PERFOVERHAUL.Keybindings.ToggleHud",
    editable: [{key: "KeyP", modifiers: [CONTROL, SHIFT]}],
    onDown: () => {
      game.settings.set(MODULE_ID, "hudEnabled", !game.settings.get(MODULE_ID, "hudEnabled"));
      return true;
    }
  });
  game.keybindings.register(MODULE_ID, "openProfiler", {
    name: "PERFOVERHAUL.Keybindings.OpenProfiler",
    editable: [],
    onDown: () => {
      new ProfilerApp().render({force: true});
      return true;
    }
  });
}
