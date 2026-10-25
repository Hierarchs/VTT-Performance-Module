import {getSetting, warn, wrapMethod} from "./constants.mjs";

/** How far beyond the visible screen, as a fraction of its size, still counts as on-screen. */
const VIEW_MARGIN = 0.25;

const PAN_THROTTLE_MS = 100;

/** Signatures longer than this are not worth comparing; the redraw just happens. */
const MAX_SIGNATURE_LENGTH = 4000;

const BAR_NAMES = ["bar1", "bar2"];

/**
 * Cached and batched token UI: resource bars and status effect icons.
 *
 * Core redraws a token's bars (clearing and rebuilding their graphics) and its effect icons (destroying and
 * recreating every icon sprite) whenever the token's render flags ask for it, which happens on most actor
 * updates whether or not anything the bars or icons show has changed.
 *
 * - Bar cache: skip drawBars when the bar values, the attribute data behind them, and the token size are
 *   unchanged since the last draw.
 * - Effect cache: skip drawEffects when the set of effect icons, tints, and overlays is unchanged.
 * - Batching: redraws for tokens outside the viewport (or hidden from this user) wait until the token comes
 *   into view, and overlapping effect redraws of one token collapse into a single trailing redraw.
 *
 * Both methods are wrapped on CONFIG.Token.objectClass, the system's own Token class, so a skipped redraw skips
 * the system's version of the method too, never just core's half of it.
 */
export class TokenUI {

  /** Counters shown in the performance HUD. */
  static stats = {barsCached: 0, effectsCached: 0, effectsMerged: 0};

  /** @type {WeakMap<PIXI.Container, string>} */
  static #barKeys = new WeakMap();

  /** @type {WeakMap<PIXI.Container, string>} */
  static #effectKeys = new WeakMap();

  /** @type {WeakMap<Token, {again: boolean, promise: Promise}>} */
  static #inflight = new WeakMap();

  /** Tokens with redraws waiting for them to come into view. @type {Map<Token, Set<string>>} */
  static #stale = new Map();

  static #viewport = null;
  static #viewportFrame = -1;
  static #lastPanCheck = 0;
  static #panTimer = null;

  /** How many tokens have redraws waiting. */
  static get waiting() {
    return this.#stale.size;
  }

  static initialize() {
    Hooks.once("setup", () => this.#patch());
    Hooks.on("canvasReady", () => {
      this.#viewport = null;
      this.#flushVisible();
    });
    Hooks.on("canvasTearDown", () => this.#stale.clear());
    Hooks.on("canvasPan", () => this.#onViewChange());
    Hooks.on("refreshToken", token => this.#flushToken(token));
    Hooks.on("controlToken", (token, controlled) => {
      if ( controlled ) this.#flushToken(token);
    });
    Hooks.on("hoverToken", (token, hovered) => {
      if ( hovered ) this.#flushToken(token);
    });
    window.addEventListener("resize", () => this.#onViewChange(), {passive: true});
  }

  /**
   * Draw every waiting token now, wherever it is.
   */
  static flushAll() {
    for ( const token of Array.from(this.#stale.keys()) ) this.#requestRedraw(token);
  }

  /* -------------------------------------------- */

  static #patch() {
    try {
      const proto = CONFIG.Token.objectClass?.prototype;
      if ( (typeof proto?.drawBars !== "function") || (typeof proto?.drawEffects !== "function") ) {
        warn("Token UI optimizations are unavailable: this Foundry version has no Token#drawBars/drawEffects.");
        return;
      }
      const ui = this;
      wrapMethod("CONFIG.Token.objectClass.prototype.drawBars", proto, "drawBars", function(wrapped, ...args) {
        return ui.#drawBars(this, wrapped, args);
      });
      wrapMethod("CONFIG.Token.objectClass.prototype.drawEffects", proto, "drawEffects", function(wrapped, ...args) {
        return ui.#drawEffects(this, wrapped, args);
      });
    } catch(err) {
      warn("Token UI optimizations could not be installed.", err);
    }
  }

  /* -------------------------------------------- */
  /*  Resource Bars                               */
  /* -------------------------------------------- */

  /**
   * @param {Token} token
   * @param {Function} wrapped
   * @param {any[]} args
   */
  static #drawBars(token, wrapped, args) {
    if ( this.#shouldDefer(token) ) {
      this.#markStale(token, "bars");
      return;
    }
    this.#unmark(token, "bars");
    if ( !getSetting("tokenBarCache", true) ) return wrapped(...args);

    const container = token.bars;
    const key = this.#barSignature(token);
    if ( (key !== null) && container && !container.destroyed && (this.#barKeys.get(container) === key) ) {
      this.stats.barsCached++;
      return;
    }
    const result = wrapped(...args);
    if ( (key !== null) && container ) this.#barKeys.set(container, key);
    return result;
  }

  /**
   * Everything a bar's appearance can depend on: its values, the whole attribute object they come from (systems
   * draw extras such as temporary hit points from sibling fields), and the token's size and display mode.
   * @param {Token} token
   * @returns {string|null}   Null when the bars cannot be safely compared
   */
  static #barSignature(token) {
    const doc = token.document;
    if ( typeof doc?.getBarAttribute !== "function" ) return null;
    const parts = [doc.displayBars, token.w, token.h, doc.width, doc.height, doc.disposition,
      canvas.dimensions?.size, !!token.actor];
    for ( const name of BAR_NAMES ) {
      let attribute;
      try {
        attribute = doc.getBarAttribute(name);
      } catch(err) {
        return null;
      }
      if ( !attribute ) {
        parts.push(null);
        continue;
      }
      const source = attribute.attribute ? foundry.utils.getProperty(token.actor?.system ?? {}, attribute.attribute) : null;
      parts.push([attribute.type, attribute.attribute, attribute.value, attribute.max, source ?? null]);
    }
    return this.#serialize(parts);
  }

  /* -------------------------------------------- */
  /*  Status Effects                              */
  /* -------------------------------------------- */

  /**
   * @param {Token} token
   * @param {Function} wrapped
   * @param {any[]} args
   * @returns {Promise}
   */
  static #drawEffects(token, wrapped, args) {
    const batching = getSetting("tokenUiBatching", true);
    if ( batching && this.#shouldDefer(token) ) {
      this.#markStale(token, "effects");
      return Promise.resolve(token);
    }
    this.#unmark(token, "effects");

    // A redraw is already running: run once more when it finishes, with whatever the data is by then
    const pending = this.#inflight.get(token);
    if ( batching && pending ) {
      pending.again = true;
      this.stats.effectsMerged++;
      return pending.promise;
    }

    const container = token.effects;
    const key = getSetting("tokenEffectCache", true) ? this.#effectSignature(token) : null;
    if ( (key !== null) && container && !container.destroyed && (this.#effectKeys.get(container) === key) ) {
      this.stats.effectsCached++;
      return Promise.resolve(token);
    }

    const state = {again: false, promise: null};
    state.promise = Promise.resolve(wrapped(...args))
      .then(result => {
        if ( (key !== null) && container && (token.effects === container) ) this.#effectKeys.set(container, key);
        return result;
      })
      .finally(() => {
        if ( this.#inflight.get(token) === state ) this.#inflight.delete(token);
      })
      .then(result => ((state.again && !token.destroyed) ? token.drawEffects() : result));
    if ( batching ) this.#inflight.set(token, state);
    return state.promise;
  }

  /**
   * Everything the effect icons show: which effects, in which order, with which image, tint, and overlay state.
   * An effect document's modification time is included so any edit to it invalidates the cache.
   * @param {Token} token
   * @returns {string|null}
   */
  static #effectSignature(token) {
    const effects = token.actor?.temporaryEffects ?? [];
    const parts = [!!token.actor];
    for ( const effect of effects ) {
      let overlay = false;
      try {
        overlay = !!effect.getFlag?.("core", "overlay");
      } catch(err) {}
      parts.push([effect.id ?? null, effect.img ?? effect.icon ?? null, String(effect.tint ?? ""), overlay,
        effect.name ?? null, effect._stats?.modifiedTime ?? null]);
    }
    return this.#serialize(parts);
  }

  /* -------------------------------------------- */
  /*  Viewport Batching                           */
  /* -------------------------------------------- */

  /**
   * Should this token's bar or effect redraw wait until it can be seen?
   * @param {Token} token
   * @returns {boolean}
   */
  static #shouldDefer(token) {
    if ( !getSetting("tokenUiBatching", true) ) return false;
    if ( token.destroyed || token.controlled || token.hover || token.isPreview ) return false;
    if ( token.visible === false ) return true;
    return !this.#isOnScreen(token);
  }

  /**
   * @param {Token} token
   * @returns {boolean}
   */
  static #isOnScreen(token) {
    const view = this.#getViewport();
    if ( !view ) return true;
    const bounds = token.bounds;
    const x = Number.isFinite(bounds?.x) ? bounds.x : (token.document?.x ?? 0);
    const y = Number.isFinite(bounds?.y) ? bounds.y : (token.document?.y ?? 0);
    const w = Number.isFinite(bounds?.width) ? bounds.width : (token.w ?? 0);
    const h = Number.isFinite(bounds?.height) ? bounds.height : (token.h ?? 0);
    return ((x + w) >= view.left) && (x <= view.right) && ((y + h) >= view.top) && (y <= view.bottom);
  }

  /**
   * The visible area of the scene, in scene coordinates, plus a margin. Cached for the current frame.
   * @returns {{left: number, top: number, right: number, bottom: number}|null}
   */
  static #getViewport() {
    const frame = canvas.app?.ticker?.lastTime;
    if ( this.#viewport && (frame === this.#viewportFrame) ) return this.#viewport;
    const screen = canvas.app?.renderer?.screen;
    const stage = canvas.stage;
    if ( !screen || (typeof stage?.toLocal !== "function") ) return null;
    try {
      const a = stage.toLocal({x: 0, y: 0});
      const b = stage.toLocal({x: screen.width, y: screen.height});
      const mx = Math.abs(b.x - a.x) * VIEW_MARGIN;
      const my = Math.abs(b.y - a.y) * VIEW_MARGIN;
      this.#viewport = {
        left: Math.min(a.x, b.x) - mx,
        top: Math.min(a.y, b.y) - my,
        right: Math.max(a.x, b.x) + mx,
        bottom: Math.max(a.y, b.y) + my
      };
      this.#viewportFrame = frame;
      return this.#viewport;
    } catch(err) {
      return null;
    }
  }

  static #onViewChange() {
    this.#viewport = null;
    const now = performance.now();
    if ( (now - this.#lastPanCheck) >= PAN_THROTTLE_MS ) {
      this.#lastPanCheck = now;
      this.#flushVisible();
    }

    // Always check once more after the view settles
    clearTimeout(this.#panTimer);
    this.#panTimer = setTimeout(() => {
      this.#viewport = null;
      this.#flushVisible();
    }, PAN_THROTTLE_MS);
  }

  /**
   * @param {Token} token
   * @param {string} kind
   */
  static #markStale(token, kind) {
    let kinds = this.#stale.get(token);
    if ( !kinds ) this.#stale.set(token, kinds = new Set());
    kinds.add(kind);
  }

  /**
   * @param {Token} token
   * @param {string} kind
   */
  static #unmark(token, kind) {
    const kinds = this.#stale.get(token);
    if ( !kinds ) return;
    kinds.delete(kind);
    if ( !kinds.size ) this.#stale.delete(token);
  }

  /**
   * Request the waiting redraws of a token if it can now be seen. The check matches the one the wrappers make,
   * so a token that still cannot be seen is left alone rather than bounced between frames.
   * @param {Token} token
   */
  static #flushToken(token) {
    if ( !token || !this.#stale.has(token) ) return;
    if ( this.#shouldDefer(token) ) return;
    this.#requestRedraw(token);
  }

  static #flushVisible() {
    for ( const token of Array.from(this.#stale.keys()) ) this.#flushToken(token);
  }

  /**
   * @param {Token} token
   */
  static #requestRedraw(token) {
    const kinds = this.#stale.get(token);
    this.#stale.delete(token);
    if ( !kinds || token.destroyed ) return;
    const flags = {};
    if ( kinds.has("bars") ) flags.refreshBars = true;
    if ( kinds.has("effects") ) flags.redrawEffects = flags.refreshEffects = true;
    token.renderFlags?.set(flags);
  }

  /* -------------------------------------------- */

  /**
   * @param {any} parts
   * @returns {string|null}
   */
  static #serialize(parts) {
    try {
      const text = JSON.stringify(parts);
      return (text.length <= MAX_SIGNATURE_LENGTH) ? text : null;
    } catch(err) {
      return null;
    }
  }
}
