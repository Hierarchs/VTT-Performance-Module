import {MODULE_ID} from "./constants.mjs";
import {HookProfiler} from "./hook-profiler.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

const REFRESH_MS = 2000;

/** A single call slower than one 60 fps frame drops a frame. */
const FRAME_MS = 16.7;

/**
 * The window for running a profiling session and reading its results.
 * A singleton: opening it again from the settings menu or the keybinding brings the existing window forward.
 */
export class ProfilerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static #instance = null;

  #refresh = null;

  constructor(options={}) {
    if ( ProfilerApp.#instance ) return ProfilerApp.#instance;
    super(options);
    ProfilerApp.#instance = this;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "perf-overhaul-profiler",
    classes: ["perf-overhaul", "perf-overhaul-profiler"],
    tag: "div",
    window: {
      title: "PERFOVERHAUL.Profiler.Title",
      icon: "fa-solid fa-stopwatch",
      resizable: true
    },
    position: {width: 760, height: 640},
    actions: {
      start: ProfilerApp.#onStart,
      stop: ProfilerApp.#onStop,
      reset: ProfilerApp.#onReset,
      copy: ProfilerApp.#onCopy
    }
  };

  /** @override */
  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/profiler.hbs`,
      scrollable: [".perf-scroll"]
    }
  };

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const report = HookProfiler.getReport();
    const ms = n => n.toFixed(1);
    const pct = n => (report.duration ? (100 * n / report.duration) : 0).toFixed(2);
    const severity = worst => (worst > FRAME_MS ? "perf-bad" : (worst > (FRAME_MS / 3) ? "perf-warn" : ""));
    const topSelf = report.packages[0]?.self || 1;

    return {
      active: report.active,
      hasData: report.handlers.length > 0,
      duration: (report.duration / 1000).toFixed(1),
      totalSelf: ms(report.totalSelf),
      totalPct: pct(report.totalSelf),
      packages: report.packages.map(p => ({
        label: p.label,
        guessed: p.guessed,
        handlers: p.handlers,
        calls: p.calls,
        self: ms(p.self),
        pct: pct(p.self),
        max: ms(p.max),
        bar: Math.max(1, Math.round(100 * p.self / topSelf)),
        severity: severity(p.max)
      })),
      handlers: report.handlers.slice(0, 50).map(h => ({
        label: HookProfiler.labelFor(h.source),
        guessed: !!h.source.guessed,
        hook: h.hook,
        name: h.name,
        calls: h.calls,
        self: ms(h.self),
        avg: ms(h.self / h.calls),
        max: ms(h.max),
        severity: severity(h.max)
      })),
      renders: report.renders.slice(0, 20).map(r => ({
        name: r.name,
        count: r.count,
        avg: ms(r.total / r.count),
        max: ms(r.max),
        severity: severity(r.total / r.count)
      }))
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#syncRefresh();
  }

  /** @override */
  _onClose(options) {
    clearInterval(this.#refresh);
    this.#refresh = null;
    super._onClose(options);
  }

  /* -------------------------------------------- */

  /** Keep the tables live while a session is recording. */
  #syncRefresh() {
    if ( HookProfiler.active && !this.#refresh ) {
      this.#refresh = setInterval(() => {
        if ( this.rendered ) this.render();
      }, REFRESH_MS);
    }
    else if ( !HookProfiler.active && this.#refresh ) {
      clearInterval(this.#refresh);
      this.#refresh = null;
    }
  }

  /** @this {ProfilerApp} */
  static #onStart() {
    HookProfiler.start();
    this.render();
  }

  /** @this {ProfilerApp} */
  static #onStop() {
    HookProfiler.stop();
    this.render();
  }

  /** @this {ProfilerApp} */
  static #onReset() {
    HookProfiler.reset();
    this.render();
  }

  /** @this {ProfilerApp} */
  static async #onCopy() {
    const text = HookProfiler.toText();
    try {
      await navigator.clipboard.writeText(text);
      ui.notifications.info(game.i18n.localize("PERFOVERHAUL.Profiler.Copied"));
    } catch(err) {
      console.log(text);
      ui.notifications.warn(game.i18n.localize("PERFOVERHAUL.Profiler.CopyFailed"));
    }
  }
}
