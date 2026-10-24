export const MODULE_ID = "performance-overhaul";
export const MODULE_TITLE = "Performance Overhaul";

export function log(...args) {
  console.log(`${MODULE_TITLE} |`, ...args);
}

export function warn(...args) {
  console.warn(`${MODULE_TITLE} |`, ...args);
}

/**
 * Read one of this module's settings, returning a fallback if settings are not registered yet.
 * @param {string} key
 * @param {*} [fallback]
 */
export function getSetting(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch(err) {
    return fallback;
  }
}

/**
 * Read a core setting, returning undefined if this Foundry version does not register it.
 * @param {string} key
 */
export function getCoreSetting(key) {
  if ( !game.settings?.settings?.has(`core.${key}`) ) return undefined;
  try {
    return game.settings.get("core", key);
  } catch(err) {
    return undefined;
  }
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Wrap a method permanently, using libWrapper when it is active and a manual override otherwise.
 * The wrapper is called as wrapper(wrapped, ...args) with `this` bound to the receiver, and may choose
 * not to call `wrapped` at all.
 * @param {string} path         A libWrapper target path, e.g. "foundry.canvas.animation.CanvasAnimation.animate"
 * @param {object} owner        The object that owns the method, used by the manual fallback
 * @param {string} key          The method name on the owner
 * @param {Function} wrapper    The wrapper function
 */
export function wrapMethod(path, owner, key, wrapper) {
  if ( globalThis.libWrapper && game.modules.get("lib-wrapper")?.active ) {
    libWrapper.register(MODULE_ID, path, wrapper, "MIXED");
    return;
  }

  // An inherited method is looked up on the parent at call time, so later patches to it are respected
  const isOwn = Object.prototype.hasOwnProperty.call(owner, key);
  const original = owner[key];
  const parent = Object.getPrototypeOf(owner);
  owner[key] = function(...args) {
    const fn = isOwn ? original : parent[key];
    return wrapper.call(this, fn.bind(this), ...args);
  };
}

/**
 * Resolve once the browser is idle, or after a timeout.
 * @param {number} [timeout=2000]
 * @returns {Promise<void>}
 */
export function whenIdle(timeout=2000) {
  return new Promise(resolve => {
    if ( "requestIdleCallback" in window ) window.requestIdleCallback(() => resolve(), {timeout});
    else setTimeout(resolve, 50);
  });
}
