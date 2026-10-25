import {MODULE_ID, warn} from "./constants.mjs";

/** Marks a profiling wrapper and points back at the handler it wraps. */
const ORIGINAL = Symbol("perfOverhaulOriginal");

/** When the current render of an application was requested. */
const RENDER_START = Symbol("perfOverhaulRenderStart");

/** Matches package script URLs such as /modules/dice-so-nice/main.js or /systems/dnd5e/dnd5e.mjs */
const PACKAGE_PATTERN = /\/(modules|systems|worlds)\/([^/?#\s)]+)\//;

/** Matches Foundry's own client scripts, such as /scripts/foundry.mjs */
const CORE_PATTERN = /\/scripts\/[^/?#\s)]+\.m?js/;

/** This script's own URL path, so its frames can be skipped wherever the module is installed. */
const SELF_FRAME = new URL(import.meta.url).pathname;

/**
 * @typedef {object} HandlerSource
 * @property {string} type        "module", "system", "world", "core", "macro", or "unknown"
 * @property {string} id          The package id, or the same value as type for non-packages
 * @property {boolean} [guessed]  Attribution was inferred from the handler's source text
 */

/**
 * @typedef {object} HandlerStat
 * @property {HandlerSource} source
 * @property {string} hook
 * @property {string} name
 * @property {number} calls
 * @property {number} self    Milliseconds spent in the handler itself, excluding nested hook handlers
 * @property {number} total   Milliseconds including nested hook handlers
 * @property {number} max     Slowest single call (self time)
 */

/**
 * Measures how much main-thread time every hook handler costs, attributed to the package that registered it.
 *
 * Attribution is recorded from the call stack whenever Hooks.on runs, starting the moment this script loads.
 * Handlers registered earlier (by packages that load before this module) are attributed by searching their
 * source for a package id, and are marked as guessed.
 *
 * Timing only happens during a profiling session; outside one, the only cost is a stack capture per Hooks.on.
 */
export class HookProfiler {

  static active = false;
  static startedAt = 0;
  static stoppedAt = 0;

  /** @type {WeakMap<Function, HandlerSource>} */
  static #sources = new WeakMap();

  /** Handlers belonging to the profiler itself, which are never timed. */
  static #internal = new WeakSet();

  /** @type {Map<string, HandlerStat>} */
  static #handlers = new Map();

  /** @type {Map<string, {name: string, count: number, total: number, max: number}>} */
  static #renders = new Map();

  /** Nested time accumulator used to compute self time. */
  static #childTime = 0;

  static #installed = false;
  static #renderWrapper = null;
  static #originalRender = null;
  static #renderHookId = null;

  static #onRendered = app => {
    const start = app?.[RENDER_START];
    if ( !start ) return;
    delete app[RENDER_START];
    this.#recordRender(app, performance.now() - start);
  };

  /* -------------------------------------------- */
  /*  Attribution                                 */
  /* -------------------------------------------- */

  /**
   * Patch Hooks.on to record who registers each handler, and Hooks.off so handlers can still be removed by
   * function reference while they are wrapped for timing.
   */
  static installAttribution() {
    if ( this.#installed ) return;
    this.#installed = true;
    const profiler = this;

    const originalOn = Hooks.on;
    Hooks.on = function(hook, fn, options) {
      if ( (typeof fn === "function") && !profiler.#sources.has(fn) ) {
        profiler.#sources.set(fn, profiler.#identifySource(new Error().stack));
      }
      const id = originalOn.call(Hooks, hook, fn, options);
      if ( profiler.active ) profiler.#instrumentHook(hook);
      return id;
    };

    const originalOff = Hooks.off;
    Hooks.off = function(hook, fn) {
      if ( typeof fn === "function" ) {
        const entry = Hooks.events[hook]?.find(e => (e.fn === fn) || (e.fn?.[ORIGINAL] === fn));
        if ( entry ) return originalOff.call(Hooks, hook, entry.id);
      }
      return originalOff.call(Hooks, hook, fn);
    };
  }

  /**
   * Work out which package a Hooks.on call came from.
   * @param {string} stack
   * @returns {HandlerSource}
   */
  static #identifySource(stack="") {
    const frames = stack.split("\n").filter(line => line.includes(" at ") && !line.includes(SELF_FRAME));
    for ( const frame of frames ) {
      const match = frame.match(PACKAGE_PATTERN);
      if ( match ) return {type: match[1].slice(0, -1), id: match[2]};

      // Hooks.once delegates to Hooks.on; the real caller is the next frame down
      if ( /\bonce\b/.test(frame) && CORE_PATTERN.test(frame) ) continue;
      if ( frame.includes("<anonymous>") || frame.includes("eval at") ) return {type: "macro", id: "macro"};
      return {type: "core", id: "core"};
    }
    return {type: "unknown", id: "unknown"};
  }

  /**
   * Attribute a handler registered before this module loaded by looking for a package id in its source.
   * @param {Function} fn
   * @returns {HandlerSource}
   */
  static #guessSource(fn) {
    let source = "";
    try {
      source = Function.prototype.toString.call(fn);
    } catch(err) {}
    const mentions = id => [`"${id}"`, `'${id}'`, `\`${id}`, `/${id}/`, `flags.${id}`].some(s => source.includes(s));

    const modules = [];
    for ( const module of game.modules.values() ) {
      if ( module.active && (module.id !== MODULE_ID) && mentions(module.id) ) modules.push(module.id);
    }
    if ( modules.length === 1 ) return {type: "module", id: modules[0], guessed: true};
    if ( !modules.length ) {
      if ( game.system && mentions(game.system.id) ) return {type: "system", id: game.system.id, guessed: true};
      if ( game.world && mentions(game.world.id) ) return {type: "world", id: game.world.id, guessed: true};
    }
    return {type: "unknown", id: "unattributed"};
  }

  /**
   * @param {Function} fn
   * @returns {HandlerSource}
   */
  static #sourceOf(fn) {
    let source = this.#sources.get(fn);
    if ( !source ) {
      source = this.#guessSource(fn);
      this.#sources.set(fn, source);
    }
    return source;
  }

  /* -------------------------------------------- */
  /*  Profiling Sessions                          */
  /* -------------------------------------------- */

  /**
   * Begin timing every hook handler and application render.
   * @returns {boolean}   Whether profiling started
   */
  static start() {
    if ( this.active ) return true;
    this.reset();
    this.active = true;
    if ( !this.#selfTest() ) {
      this.active = false;
      warn("Hook profiling is unavailable: this Foundry version stores hook handlers differently than expected.");
      ui.notifications?.error(game.i18n.localize("PERFOVERHAUL.Profiler.Unsupported"));
      return false;
    }
    this.startedAt = performance.now();
    this.stoppedAt = 0;
    for ( const hook of Object.getOwnPropertyNames(Hooks.events) ) this.#instrumentHook(hook);
    this.#patchRender();
    return true;
  }

  /**
   * Stop timing and restore every handler to its original function.
   */
  static stop() {
    if ( !this.active ) return;
    this.active = false;
    this.stoppedAt = performance.now();
    for ( const hook of Object.getOwnPropertyNames(Hooks.events) ) {
      for ( const entry of Hooks.events[hook] ) {
        if ( entry.fn?.[ORIGINAL] ) entry.fn = entry.fn[ORIGINAL];
      }
    }
    this.#unpatchRender();
  }

  /**
   * Clear collected measurements.
   */
  static reset() {
    this.#handlers.clear();
    this.#renders.clear();
    this.#childTime = 0;
    if ( this.active ) this.startedAt = performance.now();
    else this.startedAt = this.stoppedAt = 0;
  }

  /**
   * Confirm that wrapping a registered handler really changes what Hooks.callAll invokes. The Hooks API is
   * documented, but the shape of its stored entries is not, so this is checked rather than assumed.
   * @returns {boolean}
   */
  static #selfTest() {
    const hook = `${MODULE_ID}.selfTest`;
    let ran = 0;
    const probe = () => ran++;
    const id = Hooks.on(hook, probe);
    try {
      this.#instrumentHook(hook);
      const entry = Hooks.events[hook]?.find(e => e.id === id);
      const stat = this.#statFor(hook, probe);
      Hooks.callAll(hook);
      return !!entry && (entry.fn?.[ORIGINAL] === probe) && (ran === 1) && (stat.calls === 1);
    } catch(err) {
      return false;
    } finally {
      Hooks.off(hook, id);
      this.#handlers.clear();
    }
  }

  /* -------------------------------------------- */

  /**
   * Wrap every not-yet-wrapped handler of one hook event.
   * @param {string} hook
   */
  static #instrumentHook(hook) {
    const entries = Hooks.events[hook];
    if ( !Array.isArray(entries) ) return;
    for ( const entry of entries ) {
      const fn = entry?.fn;
      if ( (typeof fn !== "function") || fn[ORIGINAL] || this.#internal.has(fn) ) continue;
      entry.fn = this.#wrapHandler(hook, fn);
    }
  }

  /**
   * @param {string} hook
   * @param {Function} fn
   * @returns {Function}
   */
  static #wrapHandler(hook, fn) {
    const stat = this.#statFor(hook, fn);
    const profiler = this;
    const wrapped = function(...args) {
      const outerChild = profiler.#childTime;
      profiler.#childTime = 0;
      const start = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        const elapsed = performance.now() - start;
        const self = elapsed - profiler.#childTime;
        profiler.#childTime = outerChild + elapsed;
        if ( profiler.active ) {
          stat.calls++;
          stat.self += self;
          stat.total += elapsed;
          if ( self > stat.max ) stat.max = self;
        }
      }
    };
    wrapped[ORIGINAL] = fn;
    Object.defineProperty(wrapped, "name", {value: fn.name, configurable: true});
    return wrapped;
  }

  /**
   * Handlers are grouped by package, hook, and function name, so short-lived Hooks.once closures registered over
   * and over again accumulate into a single row.
   * @param {string} hook
   * @param {Function} fn
   * @returns {HandlerStat}
   */
  static #statFor(hook, fn) {
    const source = this.#sourceOf(fn);
    const name = fn.name || "(anonymous)";
    const key = `${source.type}:${source.id}|${hook}|${name}`;
    let stat = this.#handlers.get(key);
    if ( !stat ) {
      stat = {source, hook, name, calls: 0, self: 0, total: 0, max: 0};
      this.#handlers.set(key, stat);
    }
    return stat;
  }

  /* -------------------------------------------- */

  /**
   * Time ApplicationV2 renders for the duration of the session: from the latest render request to the
   * renderApplicationV2 hook that ends it. This is wall time, including awaiting data and templates.
   */
  static #patchRender() {
    const ApplicationV2 = foundry.applications?.api?.ApplicationV2;
    if ( !ApplicationV2 ) return;
    const proto = ApplicationV2.prototype;
    const original = this.#originalRender = proto.render;
    const profiler = this;
    this.#renderWrapper = proto.render = function(...args) {
      if ( profiler.active ) this[RENDER_START] = performance.now();
      return original.apply(this, args);
    };
    this.#internal.add(this.#onRendered);
    this.#renderHookId = Hooks.on("renderApplicationV2", this.#onRendered);
  }

  static #unpatchRender() {
    const ApplicationV2 = foundry.applications?.api?.ApplicationV2;
    if ( this.#renderHookId !== null ) Hooks.off("renderApplicationV2", this.#renderHookId);
    this.#renderHookId = null;
    // If something else wrapped render on top of ours, leave the chain intact; ours is inert when inactive
    if ( ApplicationV2 && (ApplicationV2.prototype.render === this.#renderWrapper) ) {
      ApplicationV2.prototype.render = this.#originalRender;
    }
    this.#renderWrapper = this.#originalRender = null;
  }

  /**
   * @param {ApplicationV2} app
   * @param {number} elapsed
   */
  static #recordRender(app, elapsed) {
    if ( app.options?.classes?.includes("perf-overhaul") ) return; // The profiler window itself
    const name = app.constructor.name;
    let stat = this.#renders.get(name);
    if ( !stat ) {
      stat = {name, count: 0, total: 0, max: 0};
      this.#renders.set(name, stat);
    }
    stat.count++;
    stat.total += elapsed;
    if ( elapsed > stat.max ) stat.max = elapsed;
  }

  /* -------------------------------------------- */
  /*  Reporting                                   */
  /* -------------------------------------------- */

  /**
   * A human-readable label for a handler source.
   * @param {HandlerSource} source
   * @returns {string}
   */
  static labelFor(source) {
    switch ( source.type ) {
      case "module": return game.modules.get(source.id)?.title ?? source.id;
      case "system": return (game.system?.id === source.id) ? game.system.title : source.id;
      case "world": return (game.world?.id === source.id) ? game.world.title : source.id;
      case "core": return game.i18n.localize("PERFOVERHAUL.Profiler.Sources.core");
      case "macro": return game.i18n.localize("PERFOVERHAUL.Profiler.Sources.macro");
      default:
        return game.i18n.localize(`PERFOVERHAUL.Profiler.Sources.${source.id === "unattributed" ? "unattributed" : "unknown"}`);
    }
  }

  /**
   * Summarize the current session.
   * @returns {{active: boolean, duration: number, totalSelf: number, packages: object[], handlers: HandlerStat[],
   *   renders: object[]}}
   */
  static getReport() {
    const end = this.active ? performance.now() : this.stoppedAt;
    const duration = this.startedAt ? Math.max(end - this.startedAt, 0) : 0;

    const handlers = Array.from(this.#handlers.values()).filter(h => h.calls > 0);
    const packages = new Map();
    let totalSelf = 0;
    for ( const h of handlers ) {
      totalSelf += h.self;
      const key = `${h.source.type}:${h.source.id}`;
      let pkg = packages.get(key);
      if ( !pkg ) {
        pkg = {key, source: h.source, label: this.labelFor(h.source), calls: 0, self: 0, max: 0, handlers: 0,
          guessed: false};
        packages.set(key, pkg);
      }
      pkg.calls += h.calls;
      pkg.self += h.self;
      pkg.handlers++;
      pkg.guessed ||= !!h.source.guessed;
      if ( h.max > pkg.max ) pkg.max = h.max;
    }

    return {
      active: this.active,
      duration,
      totalSelf,
      packages: Array.from(packages.values()).sort((a, b) => b.self - a.self),
      handlers: handlers.sort((a, b) => b.self - a.self),
      renders: Array.from(this.#renders.values()).sort((a, b) => b.total - a.total)
    };
  }

  /**
   * A plain-text version of the report, suitable for pasting into a bug report or Discord.
   * @returns {string}
   */
  static toText() {
    const report = this.getReport();
    const ms = n => `${n.toFixed(1)}ms`;
    const lines = [
      `Performance Overhaul hook profile (${(report.duration / 1000).toFixed(1)}s, `
        + `${ms(report.totalSelf)} in hook handlers)`,
      "",
      "By package (self time):"
    ];
    for ( const p of report.packages ) {
      lines.push(`  ${p.label}${p.guessed ? " (~)" : ""}: ${ms(p.self)} over ${p.calls} calls, worst ${ms(p.max)}`);
    }
    lines.push("", "Slowest handlers:");
    for ( const h of report.handlers.slice(0, 25) ) {
      lines.push(`  ${this.labelFor(h.source)} > ${h.hook} > ${h.name}: ${ms(h.self)} / ${h.calls} calls, `
        + `avg ${ms(h.self / h.calls)}, worst ${ms(h.max)}`);
    }
    lines.push("", "Window renders (wall time):");
    for ( const r of report.renders.slice(0, 15) ) {
      lines.push(`  ${r.name}: ${r.count}x, avg ${ms(r.total / r.count)}, worst ${ms(r.max)}`);
    }
    return lines.join("\n");
  }
}
