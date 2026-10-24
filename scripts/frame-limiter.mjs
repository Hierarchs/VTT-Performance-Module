import {getCoreSetting, getSetting, wrapMethod} from "./constants.mjs";

/**
 * PIXI will not throttle a Ticker below its minFPS (10) unless minFPS is lowered too, and lowering minFPS
 * uncaps deltaTime, which can make particle effects spawn a burst of particles after a long pause.
 */
const MIN_FPS = 10;

/** Animated map backgrounds and tiles are usually encoded at 24-30 fps. */
const VIDEO_MIN_FPS = 30;

const EVALUATE_INTERVAL_MS = 250;
const VIDEO_SCAN_INTERVAL_MS = 2000;

/** How deep to look into the primary canvas group for video meshes. */
const VIDEO_SCAN_DEPTH = 4;

/** Document changes that should briefly restore full frame rate so the change renders smoothly. */
const ACTIVITY_HOOKS = [
  "canvasReady", "canvasPan", "controlToken", "hoverToken", "targetToken", "moveToken",
  "createToken", "updateToken", "deleteToken", "updateTile", "updateAmbientLight", "updateWall",
  "createMeasuredTemplate", "updateMeasuredTemplate", "updateDrawing", "updateRegion", "updateScene"
];

/**
 * Adaptive frame limiter.
 *
 * Foundry renders the canvas at the full frame cap all the time, even when nothing is moving and the user is
 * reading a character sheet or typing in chat. This drops the canvas to a low frame rate while it is idle or
 * the window is in the background, and snaps straight back to full speed on canvas input or any canvas
 * animation (token movement, pings, panning), including animations triggered by other players.
 *
 * It uses the same lever as core's Maximum Framerate setting: the maxFPS of the canvas, shared, and system
 * PIXI tickers, which Canvas#_configurePerformanceMode sets.
 */
export class FrameLimiter {

  static MODES = Object.freeze({
    ACTIVE: "active",
    IDLE: "idle",
    BACKGROUND: "background",
    OFF: "off"
  });

  /** The limiter's current mode. */
  static mode = "active";

  /** The frame cap currently applied to the canvas tickers (0 means uncapped). */
  static target = 0;

  static #lastActivity = performance.now();
  static #animations = 0;
  static #videos = [];
  static #lastVideoScan = 0;

  /**
   * The frame cap Foundry itself wants, from the core Maximum Framerate and Performance Mode settings.
   * @type {number}
   */
  static get fullFPS() {
    const fps = globalThis.canvas?.performance?.fps;
    if ( Number.isFinite(fps) ) return fps;
    const setting = Number(getCoreSetting("maxFPS"));
    return Number.isFinite(setting) ? setting : 60;
  }

  static initialize() {
    this.#patchCanvasAnimation();
    this.#registerActivityListeners();
    const poke = () => this.poke();
    for ( const hook of ACTIVITY_HOOKS ) Hooks.on(hook, poke);
    setInterval(() => this.evaluate(), EVALUATE_INTERVAL_MS);
  }

  /* -------------------------------------------- */

  /**
   * Record user or canvas activity, restoring the full frame rate immediately if the limiter was throttling.
   */
  static poke() {
    this.#lastActivity = performance.now();
    if ( (this.mode === this.MODES.IDLE) || (this.mode === this.MODES.BACKGROUND) ) this.evaluate();
  }

  /* -------------------------------------------- */

  /**
   * Decide which mode the limiter should be in and apply the matching frame cap.
   */
  static evaluate() {
    const app = globalThis.canvas?.app;
    if ( !app?.ticker ) return;
    const {ACTIVE, IDLE, BACKGROUND, OFF} = this.MODES;
    const full = this.fullFPS;
    let mode = ACTIVE;
    let target = full;

    if ( !getSetting("limiterEnabled", false) ) mode = OFF;
    else if ( canvas.ready && (this.#animations === 0) ) {
      const background = document.hidden || !document.hasFocus();
      const idleFor = performance.now() - this.#lastActivity;
      if ( background ) {
        mode = BACKGROUND;
        target = getSetting("backgroundFPS", 10);
      }
      else if ( idleFor > (getSetting("idleDelay", 5) * 1000) ) {
        mode = IDLE;
        target = getSetting("idleFPS", 20);
      }

      if ( mode !== ACTIVE ) {
        if ( getSetting("smoothVideo", true) && this.#hasPlayingVideo() ) target = Math.max(target, VIDEO_MIN_FPS);
        target = Math.max(target, MIN_FPS);

        // Throttling to the full rate or above would change nothing
        if ( (full > 0) && (target >= full) ) {
          mode = ACTIVE;
          target = full;
        }
      }
    }

    this.mode = mode;
    this.#apply(target);
  }

  /* -------------------------------------------- */

  /**
   * Apply a frame cap to every ticker Foundry configures in Canvas#_configurePerformanceMode.
   * @param {number} fps
   */
  static #apply(fps) {
    this.target = fps;
    for ( const ticker of [canvas.app.ticker, PIXI.Ticker.shared, PIXI.Ticker.system] ) {
      if ( ticker && (ticker.maxFPS !== fps) ) ticker.maxFPS = fps;
    }
  }

  /* -------------------------------------------- */

  /**
   * Count in-flight canvas animations so token movement, panning, pings, and scrolling text always render at
   * full speed, whoever started them.
   */
  static #patchCanvasAnimation() {
    const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;
    const limiter = this;
    wrapMethod("foundry.canvas.animation.CanvasAnimation.animate", CanvasAnimation, "animate", function(wrapped, ...args) {
      const result = wrapped(...args);
      if ( !(result instanceof Promise) ) return result;
      limiter.#animations++;
      limiter.evaluate();
      result.finally(() => {
        limiter.#animations = Math.max(0, limiter.#animations - 1);
        limiter.evaluate();
      }).catch(() => {});
      return result;
    });
  }

  /* -------------------------------------------- */

  static #registerActivityListeners() {
    const options = {capture: true, passive: true};
    const onPointer = event => {
      const view = globalThis.canvas?.app?.view ?? globalThis.canvas?.app?.canvas;
      if ( view && (event.target === view) ) this.poke();
    };
    for ( const type of ["pointerdown", "pointermove", "wheel", "dragover"] ) {
      window.addEventListener(type, onPointer, options);
    }

    // Keyboard canvas controls (panning, token movement) count; typing into chat or a sheet does not
    window.addEventListener("keydown", event => {
      if ( !this.#isEditable(event.target) ) this.poke();
    }, options);

    const reevaluate = () => this.evaluate();
    window.addEventListener("focus", reevaluate);
    window.addEventListener("blur", reevaluate);
    document.addEventListener("visibilitychange", reevaluate);
  }

  /**
   * @param {EventTarget} target
   * @returns {boolean}
   */
  static #isEditable(target) {
    if ( !(target instanceof HTMLElement) ) return false;
    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  /* -------------------------------------------- */

  /**
   * Is any video texture on the current scene playing? The list of videos is rescanned every couple of seconds.
   * @returns {boolean}
   */
  static #hasPlayingVideo() {
    const now = performance.now();
    if ( (now - this.#lastVideoScan) > VIDEO_SCAN_INTERVAL_MS ) {
      this.#lastVideoScan = now;
      this.#videos = this.#collectVideos();
    }
    return this.#videos.some(video => !video.paused && !video.ended);
  }

  /**
   * Find video elements behind the meshes of the primary canvas group (level backgrounds and foregrounds,
   * tiles, and tokens all draw there), plus any tile placeables.
   * @returns {HTMLVideoElement[]}
   */
  static #collectVideos() {
    const videos = new Set();
    const visit = (object, depth) => {
      if ( !object || (depth > VIDEO_SCAN_DEPTH) ) return;
      try {
        if ( object.isVideo && (object.sourceElement instanceof HTMLVideoElement) ) videos.add(object.sourceElement);
      } catch(err) {}
      if ( Array.isArray(object.children) ) {
        for ( const child of object.children ) visit(child, depth + 1);
      }
    };
    visit(canvas.primary, 0);
    for ( const tile of canvas.tiles?.placeables ?? [] ) visit(tile, VIDEO_SCAN_DEPTH);
    return Array.from(videos);
  }
}
