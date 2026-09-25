// frontend/src/lib/perfTier.js
//
// Cheap, cached "is this a lower-powered device" check used by the 3D
// viewers to trim GPU work (antialiasing, pixel ratio, mesh detail) on
// phones/tablets — where a full desktop-detail WebGL scene is exactly
// what turns "smooth on desktop" into "laggy on Android".
//
// Deliberately conservative: every call site only *reduces* work when
// this returns true. Desktop/laptop browsers (fine pointer, no core-count
// red flag) always get the original, unchanged behaviour.
let cached = null;

export function isLowPowerDevice() {
  if (cached !== null) return cached;
  if (typeof window === 'undefined' || !window.matchMedia) {
    cached = false;
    return cached;
  }
  // Primary signal: the input is touch/coarse (phones, tablets) — this is
  // the actual population where the animation-heavy pages were reported
  // to lag, regardless of how fast that particular device's CPU/GPU is.
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  // Secondary signal, for the odd touch device that reports a fine
  // pointer (some Android + stylus setups): a low logical core count is a
  // reasonable proxy for a mid/low-tier mobile SoC.
  const fewCores =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency > 0 &&
    navigator.hardwareConcurrency <= 4;
  cached = coarsePointer || fewCores;
  return cached;
}