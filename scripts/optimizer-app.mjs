import {MODULE_ID, getCoreSetting, getSetting} from "./constants.mjs";
import {ProfilerApp} from "./profiler-app.mjs";

const {ApplicationV2, HandlebarsApplicationMixin, DialogV2} = foundry.applications.api;

/**
 * Settings bundles. Every setting here is client-scoped, so applying a preset only affects this browser. Core
 * settings this Foundry version does not register are skipped.
 * performanceMode uses CONST.CANVAS_PERFORMANCE_MODES: 0 Low, 1 Medium, 2 High, 3 Maximum.
 */
const PRESETS = {
  quality: {
    icon: "fa-solid fa-gem",
    core: {
      performanceMode: 2, maxFPS: 60, pixelRatioResolutionScaling: true,
      lightAnimation: true, visionAnimation: true, chatBubblesPan: true
    },
    module: {idleFPS: 30, backgroundFPS: 15}
  },
  balanced: {
    icon: "fa-solid fa-scale-balanced",
    core: {
      performanceMode: 1, maxFPS: 60, pixelRatioResolutionScaling: false,
      lightAnimation: true, visionAnimation: true, chatBubblesPan: true
    },
    module: {idleFPS: 20, backgroundFPS: 10}
  },
  performance: {
    icon: "fa-solid fa-bolt",
    core: {
      performanceMode: 0, maxFPS: 30, pixelRatioResolutionScaling: false,
      lightAnimation: false, visionAnimation: false, chatBubblesPan: false
    },
    module: {idleFPS: 10, backgroundFPS: 10}
  }
};

const PRESET_ORDER = ["quality", "balanced", "performance"];

const SEVERITY_ORDER = ["critical", "warning", "info", "ok"];

const SEVERITY_ICONS = {
  critical: "fa-solid fa-circle-xmark",
  warning: "fa-solid fa-triangle-exclamation",
  info: "fa-solid fa-circle-info",
  ok: "fa-solid fa-circle-check"
};

/** Maps at or above this size cost a lot of VRAM and upload time even on good GPUs. */
const LARGE_MAP_PX = 8192;
const MANY_CHAT_MESSAGES = 1000;
const MANY_WALLS = 3000;
const MANY_TOKENS = 150;

/**
 * A health report for this client and the current scene, plus one-click setting presets.
 */
export class OptimizerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "perf-overhaul-optimizer",
    classes: ["perf-overhaul", "perf-overhaul-optimizer"],
    tag: "div",
    window: {
      title: "PERFOVERHAUL.Optimizer.Title",
      icon: "fa-solid fa-gauge-high",
      resizable: true
    },
    position: {width: 700, height: "auto"},
    actions: {
      applyPreset: OptimizerApp.#onApplyPreset,
      profiler: OptimizerApp.#onOpenProfiler,
      hud: OptimizerApp.#onToggleHud,
      refresh: OptimizerApp.#onRefresh
    }
  };

  /** @override */
  static PARTS = {
    main: {template: `modules/${MODULE_ID}/templates/optimizer.hbs`}
  };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const rows = [];
    for ( const [namespace, keys] of [["core", Object.keys(PRESETS.quality.core)], [MODULE_ID, Object.keys(PRESETS.quality.module)]] ) {
      for ( const key of keys ) {
        const setting = game.settings.settings.get(`${namespace}.${key}`);
        if ( !setting ) continue;
        const current = game.settings.get(namespace, key);
        rows.push({
          label: OptimizerApp.#labelFor(namespace, key, setting),
          current: OptimizerApp.#format(setting, current),
          presets: PRESET_ORDER.map(id => {
            const value = OptimizerApp.#presetValues(id, namespace)[key];
            return {value: OptimizerApp.#format(setting, value), changed: value !== current};
          })
        });
      }
    }

    return {
      checks: OptimizerApp.healthChecks(),
      presets: PRESET_ORDER.map(id => ({
        id,
        icon: PRESETS[id].icon,
        label: game.i18n.localize(`PERFOVERHAUL.Optimizer.Presets.${id}.Name`),
        hint: game.i18n.localize(`PERFOVERHAUL.Optimizer.Presets.${id}.Hint`),
        current: OptimizerApp.#matchesPreset(id)
      })),
      rows,
      hudEnabled: getSetting("hudEnabled", false)
    };
  }

  /* -------------------------------------------- */

  /**
   * @param {string} id
   * @param {string} namespace
   * @returns {object}
   */
  static #presetValues(id, namespace) {
    return namespace === "core" ? PRESETS[id].core : PRESETS[id].module;
  }

  static #labelFor(namespace, key, setting) {
    return game.i18n.localize(namespace === "core" ? (setting.name ?? key) : `PERFOVERHAUL.Settings.${key}.Name`);
  }

  /**
   * @param {object} setting    A registered setting config
   * @param {*} value
   * @returns {string}
   */
  static #format(setting, value) {
    if ( typeof value === "boolean" ) return game.i18n.localize(value ? "PERFOVERHAUL.On" : "PERFOVERHAUL.Off");
    let choices = setting.choices ?? setting.type?.choices;
    if ( typeof choices === "function" ) choices = choices();
    if ( choices && (typeof choices === "object") ) {
      if ( !(value in choices) ) return game.i18n.localize("PERFOVERHAUL.Auto");
      const choice = choices[value];
      return game.i18n.localize(typeof choice === "object" ? (choice.label ?? String(value)) : choice);
    }
    return String(value);
  }

  /**
   * Can this setting hold this preset value? Core settings may be declared with a constructor (Boolean, Number)
   * or with a data field.
   * @param {object} setting
   * @param {*} value
   * @returns {boolean}
   */
  static #accepts(setting, value) {
    const fields = foundry.data?.fields ?? {};
    const type = setting.type;
    if ( typeof value === "boolean" ) return (type === Boolean) || (!!fields.BooleanField && (type instanceof fields.BooleanField));
    if ( typeof value === "number" ) return (type === Number) || (!!fields.NumberField && (type instanceof fields.NumberField));
    return false;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  static #matchesPreset(id) {
    const preset = PRESETS[id];
    const coreMatches = Object.entries(preset.core).every(([key, value]) => {
      const current = getCoreSetting(key);
      return (current === undefined) || (current === value);
    });
    return coreMatches && Object.entries(preset.module).every(([key, value]) => getSetting(key) === value);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * Apply a preset's client settings, then reload.
   * @this {OptimizerApp}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onApplyPreset(event, target) {
    const id = target.dataset.preset;
    const preset = PRESETS[id];
    if ( !preset ) return;

    const changes = [];
    for ( const namespace of ["core", MODULE_ID] ) {
      for ( const [key, value] of Object.entries(OptimizerApp.#presetValues(id, namespace)) ) {
        const setting = game.settings.settings.get(`${namespace}.${key}`);
        if ( !setting || (setting.scope !== "client") || !OptimizerApp.#accepts(setting, value) ) continue;
        const current = game.settings.get(namespace, key);
        if ( current !== value ) changes.push({namespace, key, setting, current, value});
      }
    }

    if ( !changes.length ) {
      ui.notifications.info(game.i18n.localize("PERFOVERHAUL.Optimizer.NoChanges"));
      return;
    }

    const items = changes.map(c => {
      const label = OptimizerApp.#labelFor(c.namespace, c.key, c.setting)
        .replace(/[&<>"]/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[ch]);
      return `<li>${label}: ${OptimizerApp.#format(c.setting, c.current)} &rarr; `
        + `<strong>${OptimizerApp.#format(c.setting, c.value)}</strong></li>`;
    });
    const name = game.i18n.localize(`PERFOVERHAUL.Optimizer.Presets.${id}.Name`);
    const confirmed = await DialogV2.confirm({
      window: {title: game.i18n.format("PERFOVERHAUL.Optimizer.ConfirmTitle", {name})},
      content: `<p>${game.i18n.localize("PERFOVERHAUL.Optimizer.ConfirmIntro")}</p><ul>${items.join("")}</ul>`
        + `<p>${game.i18n.localize("PERFOVERHAUL.Optimizer.ConfirmReload")}</p>`,
      rejectClose: false,
      modal: true
    });
    if ( confirmed !== true ) return;

    for ( const c of changes ) await game.settings.set(c.namespace, c.key, c.value);
    foundry.utils.debouncedReload();
  }

  /** @this {OptimizerApp} */
  static #onOpenProfiler() {
    new ProfilerApp().render({force: true});
  }

  /** @this {OptimizerApp} */
  static async #onToggleHud() {
    await game.settings.set(MODULE_ID, "hudEnabled", !getSetting("hudEnabled", false));
    this.render();
  }

  /** @this {OptimizerApp} */
  static #onRefresh() {
    this.render();
  }

  /* -------------------------------------------- */
  /*  Health Report                               */
  /* -------------------------------------------- */

  /**
   * Inspect this client, the current scene, and the world for known performance problems.
   * @returns {{level: string, icon: string, title: string, detail: string}[]}
   */
  static healthChecks() {
    const checks = [];
    const add = (level, key, data={}) => checks.push({
      level,
      icon: SEVERITY_ICONS[level],
      title: game.i18n.format(`PERFOVERHAUL.Health.${key}.Title`, data),
      detail: game.i18n.format(`PERFOVERHAUL.Health.${key}.Detail`, data)
    });
    const attempt = fn => {
      try {
        fn();
      } catch(err) {
        console.debug(`${MODULE_ID} | Health check skipped`, err);
      }
    };

    // Graphics
    let maxTexture = 0;
    attempt(() => {
      const renderer = canvas?.app?.renderer;
      const gl = renderer?.gl;
      if ( !gl ) return;
      maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const info = String((debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "");
      if ( /swiftshader|llvmpipe|software|basic render/i.test(info) ) add("critical", "SoftwareRendering", {renderer: info});
      else if ( info ) add("ok", "GPU", {renderer: info, max: maxTexture});
      if ( renderer.context?.webGLVersion === 1 ) add("warning", "WebGL1");
    });

    attempt(() => {
      const dpr = window.devicePixelRatio || 1;
      if ( (dpr > 1) && (getCoreSetting("pixelRatioResolutionScaling") === true) ) {
        add("warning", "PixelRatio", {dpr: dpr.toFixed(2), saving: Math.round((1 - (1 / (dpr * dpr))) * 100)});
      }
    });

    attempt(() => {
      if ( getCoreSetting("performanceMode") === CONST.CANVAS_PERFORMANCE_MODES.MAX ) add("info", "MaxMode");
    });

    attempt(() => {
      const bytes = foundry.canvas.TextureLoader.approximateTotalMemoryUsage;
      if ( Number.isFinite(bytes) && bytes > 0 ) add("ok", "TextureMemory", {mb: Math.round(bytes / 1048576)});
    });

    // Current scene and level
    attempt(() => {
      if ( !canvas?.ready || !canvas.scene ) return;
      const src = canvas.level?.background?.src || canvas.scene.background?.src || "";
      const base = src ? foundry.canvas.TextureLoader.loader.getCache(src) : null;
      if ( base?.valid && Number.isFinite(base.realWidth) ) {
        const w = base.realWidth;
        const h = base.realHeight;
        const mb = Math.round((w * h * 4 * (4 / 3)) / 1048576);
        if ( maxTexture && (Math.max(w, h) > maxTexture) ) add("critical", "TextureTooLarge", {w, h, max: maxTexture});
        else if ( Math.max(w, h) > LARGE_MAP_PX ) add("warning", "LargeMap", {w, h, mb});
        else add("ok", "MapSize", {w, h, mb});
      }

      const ext = src.split("?")[0].split(".").pop()?.toLowerCase();
      if ( ["png", "bmp", "tif", "tiff"].includes(ext) ) add("info", "MapFormat", {ext: ext.toUpperCase()});

      const lights = canvas.lighting?.placeables ?? [];
      const animated = lights.filter(l => l.document?.config?.animation?.type).length;
      if ( animated ) add("info", "AnimatedLights", {count: animated, total: lights.length});

      const walls = canvas.walls?.placeables?.length ?? 0;
      if ( walls > MANY_WALLS ) add("warning", "ManyWalls", {count: walls});

      const tokens = canvas.tokens?.placeables?.length ?? 0;
      if ( tokens > MANY_TOKENS ) add("info", "ManyTokens", {count: tokens});

      const videos = (canvas.tiles?.placeables ?? []).filter(t => t.isVideo).length;
      if ( videos ) add("info", "Videos", {count: videos});
    });

    // World
    attempt(() => {
      const count = game.messages.size;
      if ( count > MANY_CHAT_MESSAGES ) add("warning", "ChatLog", {count});
    });

    attempt(() => {
      if ( game.user.isGM && (getCoreSetting("tokenDragPreview") === true) ) add("info", "DragPreview");
    });

    attempt(() => {
      const count = Array.from(game.modules.values()).filter(m => m.active).length;
      add("info", "Modules", {count});
    });

    if ( !getSetting("limiterEnabled", true) ) add("info", "LimiterOff");

    return checks.sort((a, b) => SEVERITY_ORDER.indexOf(a.level) - SEVERITY_ORDER.indexOf(b.level));
  }
}
