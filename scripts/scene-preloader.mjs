import {getSetting, warn, whenIdle} from "./constants.mjs";

/** Give the scene that just loaded room to settle before using the network for anything else. */
const START_DELAY_MS = 4000;

/** Scene changes that alter which scenes are worth preloading. */
const NAVIGATION_KEYS = ["navigation", "navOrder", "active", "ownership"];

/**
 * Quiet background preloading of the scenes a player is likely to visit next.
 *
 * Core's "Preload Scene" is manual, GM-only, and shows a loading bar on every client. This instead loads the
 * textures of the nearest scenes in the navigation bar (the active scene first), one scene and one file at a
 * time, during idle moments. It uses core's own TextureLoader.loadSceneTextures, so whatever core would load
 * for a scene (including its Levels) is what gets cached, but with the progress bar suppressed and without
 * expiring anything already cached. When the scene is opened later its textures are already there.
 */
export class ScenePreloader {

  /** Progress shown in the performance HUD, counted in scenes. */
  static status = {loaded: 0, total: 0};

  /** Incremented on every reschedule so a run in progress can notice it has been superseded. */
  static #generation = 0;

  static initialize() {
    Hooks.on("canvasReady", () => this.schedule());
    Hooks.on("updateScene", (scene, changes) => {
      if ( NAVIGATION_KEYS.some(k => k in changes) ) this.schedule();
    });
  }

  /**
   * Cancel any run in progress and start a new one shortly.
   */
  static schedule() {
    const generation = ++this.#generation;
    this.status = {loaded: 0, total: 0};
    setTimeout(() => {
      this.#run(generation).catch(err => warn("Scene preloading stopped after an error.", err));
    }, START_DELAY_MS);
  }

  /* -------------------------------------------- */

  /**
   * @param {number} generation
   */
  static async #run(generation) {
    const limit = getSetting("preloadScenes", 0);
    if ( !limit || !canvas.ready || (generation !== this.#generation) ) return;
    const scenes = this.#candidates(limit);
    this.status = {loaded: 0, total: scenes.length};
    for ( const scene of scenes ) {
      await whenIdle();
      if ( generation !== this.#generation ) return;
      await this.#preload(scene);
      this.status.loaded++;
    }
  }

  /**
   * The scenes most likely to be opened next, nearest first: the active scene if this client is viewing another
   * one, then neighbours in navigation-bar order.
   * @param {number} limit
   * @returns {Scene[]}
   */
  static #candidates(limit) {
    const current = canvas.scene;
    const canSee = scene => game.user.isGM || scene.active || (scene.visible ?? false);
    const nav = game.scenes.filter(s => (s.navigation && canSee(s)) || s.active || (s === current))
      .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0));
    const here = nav.indexOf(current);
    const distance = scene => {
      if ( scene.active ) return -1;
      const index = nav.indexOf(scene);
      return here >= 0 ? Math.abs(index - here) : index;
    };
    return nav.filter(s => s !== current)
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, limit);
  }

  /**
   * Load one scene's textures through core, intercepting the loader call it makes so that it loads one file at a
   * time, shows no progress bar, expires nothing, and (unless enabled) skips video files.
   * @param {Scene} scene
   */
  static async #preload(scene) {
    const TextureLoader = foundry.canvas.TextureLoader;
    const loader = TextureLoader.loader;
    const includeVideo = getSetting("preloadVideos", false);
    const isVideo = src => foundry.helpers.media.VideoHelper.hasVideoExtension(src);

    const hadOwn = Object.prototype.hasOwnProperty.call(loader, "load");
    const original = loader.load;
    loader.load = function(sources, options={}) {
      const wanted = includeVideo ? sources : sources.filter(src => !isVideo(src));
      return original.call(this, wanted, {...options, displayProgress: false, expireCache: false, maxConcurrent: 1});
    };

    // The override only needs to cover the synchronous part of loadSceneTextures, where it hands its source list
    // to the loader; it is removed straight away so a real scene load is never affected.
    let promise;
    try {
      promise = TextureLoader.loadSceneTextures(scene, {expireCache: false, maxConcurrent: 1});
    } finally {
      if ( hadOwn ) loader.load = original;
      else delete loader.load;
    }

    try {
      await promise;
    } catch(err) {
      // Missing or cross-origin files fail quietly here; core reports them if the scene is ever opened
    }
  }
}
