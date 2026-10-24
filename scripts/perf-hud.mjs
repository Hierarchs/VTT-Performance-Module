import {MODULE_ID, clamp, getSetting} from "./constants.mjs";
import {FrameLimiter} from "./frame-limiter.mjs";
import {ScenePreloader} from "./scene-preloader.mjs";

const LONG_TASK_WINDOW_MS = 10000;
const DOM_COUNT_INTERVAL_MS = 5000;

/**
 * A small draggable overlay showing what the client is actually doing: rendered FPS, CPU time per frame,
 * the frame limiter's mode, main-thread stalls, memory, and what is on the canvas.
 */
export class PerfHud {

  /** The most recent measurements. */
  static stats = {fps: 0, cpuAvg: 0, cpuMax: 0};

  static #element = null;
  static #interval = null;
  static #observer = null;
  static #ticker = null;
  static #frames = 0;
  static #cpuTotal = 0;
  static #cpuMax = 0;
  static #frameStart = 0;
  static #windowStart = performance.now();
  static #longTasks = [];
  static #domCount = 0;
  static #domCountedAt = 0;

  static #onFrameStart = () => {
    this.#frameStart = performance.now();
  };

  static #onFrameEnd = () => {
    if ( !this.#frameStart ) return;
    const cpu = performance.now() - this.#frameStart;
    this.#frameStart = 0;
    this.#frames++;
    this.#cpuTotal += cpu;
    if ( cpu > this.#cpuMax ) this.#cpuMax = cpu;
  };

  static initialize() {
    Hooks.once("ready", () => {
      if ( getSetting("hudEnabled", false) ) this.toggle(true);
    });
    Hooks.on("canvasReady", () => {
      if ( this.#element?.isConnected ) this.#attachTicker();
    });
  }

  /**
   * Show or hide the HUD.
   * @param {boolean} enabled
   */
  static toggle(enabled) {
    if ( enabled ) this.#show();
    else this.#hide();
  }

  /* -------------------------------------------- */

  static #show() {
    this.#element ??= this.#createElement();
    if ( !this.#element.isConnected ) document.body.append(this.#element);
    this.#attachTicker();
    this.#observeLongTasks();
    this.#windowStart = performance.now();
    this.#interval ??= setInterval(() => this.#update(), 1000);
    this.#update();
  }

  static #hide() {
    this.#element?.remove();
    this.#detachTicker();
    this.#observer?.disconnect();
    this.#observer = null;
    clearInterval(this.#interval);
    this.#interval = null;
  }

  /* -------------------------------------------- */

  /**
   * Bracket each canvas frame with listeners at the very highest and lowest ticker priority, so the time between
   * them covers every ticker callback plus the PIXI render (which runs at UPDATE_PRIORITY.LOW).
   */
  static #attachTicker() {
    const ticker = globalThis.canvas?.app?.ticker;
    if ( !ticker || (ticker === this.#ticker) ) return;
    this.#detachTicker();
    ticker.add(this.#onFrameStart, null, 1000);
    ticker.add(this.#onFrameEnd, null, -1000);
    this.#ticker = ticker;
  }

  static #detachTicker() {
    this.#ticker?.remove(this.#onFrameStart, null);
    this.#ticker?.remove(this.#onFrameEnd, null);
    this.#ticker = null;
  }

  static #observeLongTasks() {
    if ( this.#observer || !("PerformanceObserver" in window) ) return;
    try {
      this.#observer = new PerformanceObserver(list => {
        for ( const entry of list.getEntries() ) this.#longTasks.push({time: entry.startTime, duration: entry.duration});
      });
      this.#observer.observe({type: "longtask", buffered: false});
    } catch(err) {
      this.#observer = null;
    }
  }

  /* -------------------------------------------- */

  static #update() {
    if ( !this.#element?.isConnected ) return;
    const now = performance.now();
    const seconds = Math.max((now - this.#windowStart) / 1000, 0.001);
    const fps = this.#frames / seconds;
    const cpuAvg = this.#frames ? (this.#cpuTotal / this.#frames) : 0;
    this.stats = {fps, cpuAvg, cpuMax: this.#cpuMax};
    this.#frames = 0;
    this.#cpuTotal = 0;
    this.#cpuMax = 0;
    this.#windowStart = now;

    this.#longTasks = this.#longTasks.filter(t => (now - t.time) < LONG_TASK_WINDOW_MS);
    const worstStall = this.#longTasks.reduce((max, t) => Math.max(max, t.duration), 0);

    if ( (now - this.#domCountedAt) > DOM_COUNT_INTERVAL_MS ) {
      this.#domCount = document.getElementsByTagName("*").length;
      this.#domCountedAt = now;
    }

    const i18n = key => game.i18n.localize(`PERFOVERHAUL.Hud.${key}`);
    const cap = FrameLimiter.target ? `${FrameLimiter.target}` : "∞";
    const heap = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : "—";
    const effects = canvas?.effects;
    const preload = ScenePreloader.status;
    const textureMB = foundry.canvas.TextureLoader?.approximateTotalMemoryUsage;
    const count = layer => layer?.placeables?.length ?? 0;

    const rows = [
      [i18n("FPS"), `${fps.toFixed(0)} / ${cap}`, `mode-${FrameLimiter.mode}`],
      [i18n("Mode"), i18n(`Modes.${FrameLimiter.mode}`), `mode-${FrameLimiter.mode}`],
      [i18n("FrameCPU"), `${cpuAvg.toFixed(1)} ms (${i18n("Max")} ${this.stats.cpuMax.toFixed(1)})`],
      [i18n("Stalls"), this.#longTasks.length ? `${this.#longTasks.length} (${i18n("Worst")} ${worstStall.toFixed(0)} ms)` : "0"],
      [i18n("Heap"), heap],
      [i18n("Textures"), Number.isFinite(textureMB) ? `${Math.round(textureMB / 1048576)} MB` : "—"],
      [i18n("DOM"), this.#domCount.toLocaleString()],
      [i18n("Canvas"), canvas?.ready ? [
        `${count(canvas.tokens)} ${i18n("Tokens")}`,
        `${count(canvas.lighting)} ${i18n("Lights")}`,
        `${count(canvas.walls)} ${i18n("Walls")}`
      ].join(" · ") : "—"],
      [i18n("Sources"), effects ? `${effects.lightSources?.size ?? 0} ${i18n("Light")} · ${effects.visionSources?.size ?? 0} ${i18n("Vision")}` : "—"],
      [i18n("Preload"), preload.total ? `${preload.loaded}/${preload.total} ${i18n("Scenes")}` : i18n("PreloadIdle")]
    ];

    const body = this.#element.querySelector(".perf-hud-body");
    body.replaceChildren(...rows.map(([label, value, cls]) => {
      const row = document.createElement("div");
      row.className = "perf-hud-row";
      const dt = document.createElement("span");
      dt.className = "perf-hud-label";
      dt.textContent = label;
      const dd = document.createElement("span");
      dd.className = `perf-hud-value ${cls ?? ""}`;
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }));
  }

  /* -------------------------------------------- */

  static #createElement() {
    const element = document.createElement("section");
    element.id = "perf-overhaul-hud";
    element.innerHTML = `
      <header class="perf-hud-header">
        <i class="fa-solid fa-gauge-high"></i>
        <span>${game.i18n.localize("PERFOVERHAUL.Hud.Title")}</span>
        <a class="perf-hud-close" title="${game.i18n.localize("Close")}"><i class="fa-solid fa-xmark"></i></a>
      </header>
      <div class="perf-hud-body"></div>`;

    const position = getSetting("hudPosition", {}) ?? {};
    if ( Number.isFinite(position.left) && Number.isFinite(position.top) ) {
      element.style.left = `${clamp(position.left, 0, window.innerWidth - 60)}px`;
      element.style.top = `${clamp(position.top, 0, window.innerHeight - 30)}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
    }

    element.querySelector(".perf-hud-close").addEventListener("click", () => {
      game.settings.set(MODULE_ID, "hudEnabled", false);
    });
    this.#makeDraggable(element, element.querySelector(".perf-hud-header"));
    return element;
  }

  /**
   * @param {HTMLElement} element
   * @param {HTMLElement} handle
   */
  static #makeDraggable(element, handle) {
    handle.addEventListener("pointerdown", event => {
      if ( event.button !== 0 || event.target.closest(".perf-hud-close") ) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      const move = moveEvent => {
        element.style.left = `${clamp(moveEvent.clientX - dx, 0, window.innerWidth - rect.width)}px`;
        element.style.top = `${clamp(moveEvent.clientY - dy, 0, window.innerHeight - rect.height)}px`;
        element.style.right = "auto";
        element.style.bottom = "auto";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const final = element.getBoundingClientRect();
        game.settings.set(MODULE_ID, "hudPosition", {left: Math.round(final.left), top: Math.round(final.top)});
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
}
