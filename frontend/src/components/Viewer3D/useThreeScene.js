import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { isLowPowerDevice } from '../../lib/perfTier';

/** Sets up a Three.js renderer/scene/camera/OrbitControls inside
 *  `containerRef` and runs the render loop. This is the Three.js
 *  counterpart to use3DmolViewer.js — same "one hook, shared by every
 *  viewer that needs it" shape — but there's no polling-for-a-global step
 *  here: Three ships as a real npm module, so it's available the instant
 *  this file is imported, unlike 3Dmol which loads from a CDN <script> tag.
 *
 *  `background`: a hex color (e.g. 0x10161a) paints the canvas that color.
 *  Pass `null` to leave the canvas transparent instead, so a CSS
 *  background/gradient placed behind the container shows through.
 *
 *  Deliberately plain lighting (no HDRI/PMREM environment, no tone-mapping
 *  override): a scene-wide procedural environment map was tried here and
 *  reverted — it blew out to a washed-out glare at some rotation angles
 *  (the environment's own bright walls reflecting off every clearcoat
 *  sphere) and the extra per-instance GPU work risked starving other
 *  simultaneously-mounted viewers on pages that show several molecules at
 *  once, which is what made controls stop responding. Three directional-
 *  ish lights + ambient is what every viewer in this app already looked
 *  right with, so that's what stays here.
 *
 *  `onFrame(dt)` runs once per rendered frame, after controls.update() and
 *  before the draw call — pass it whatever needs per-frame animation (e.g.
 *  lerping a highlighted symmetry element's glow). It's read through a ref
 *  so the caller can pass a new closure every render without tearing down
 *  and rebuilding the scene.
 *
 *  `lighting`: 'dark' (default, unchanged) keeps the original dim
 *  key/fill/ambient rig every existing dark-themed viewer (e.g. the Group
 *  Theory symmetry viewer) already looks right with. 'light' swaps in the
 *  brighter ambient + hemisphere + key/fill/rim rig the homepage's
 *  HeroMolecule uses, so atoms read correctly against a pale card instead
 *  of washing out or looking flat. */
export function useThreeScene(containerRef, { background = 0x04090d, onFrame, lighting = 'dark' } = {}) {
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'failed'

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const lowPower = isLowPowerDevice();

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: !lowPower, alpha: true, powerPreference: 'high-performance' });
    } catch {
      // No WebGL (old browser, disabled GPU, some headless/embedded
      // contexts) — report it the same way use3DmolViewer reports a CDN
      // timeout, so callers show one consistent "failed" UI either way.
      setStatus('failed');
      return undefined;
    }
    if (background === null) renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    if (background !== null) {
      scene.background = new THREE.Color(background);
      scene.fog = new THREE.FogExp2(background, 0.05);
    }

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
    camera.position.set(0, 0, 9);

    if (lighting === 'light') {
      // Same rig HeroMolecule uses on the homepage: soft ambient + hemisphere
      // fill so nothing goes muddy, plus a warm/cool key-fill-rim trio so
      // charcoal carbons still pick up real highlights on a pale card.
      scene.add(new THREE.AmbientLight(0xffffff, 1.15));
      scene.add(new THREE.HemisphereLight(0xffffff, 0xe6dfd4, 0.9));
      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(4, 6, 5);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xcfeaff, 0.9);
      fill.position.set(-5, -1, 3);
      scene.add(fill);
      const rim = new THREE.DirectionalLight(0xffe6c2, 1.1);
      rim.position.set(-2, 4, -6);
      scene.add(rim);
    } else {
      // Three-point-ish lighting: a bright key light for real shading on the
      // spheres, a dim cool fill so the shadow side isn't pure black, and a
      // soft ambient floor so nothing goes fully unlit as it spins. Kept
      // slightly under the original intensities so colors stay saturated
      // instead of blowing out to white on the lit side as the molecule
      // rotates through the key light.
      const key = new THREE.DirectionalLight(0xffffff, 2.05);
      key.position.set(4, 6, 8);
      const fill = new THREE.DirectionalLight(0x5eead4, 0.38);
      fill.position.set(-6, -2, -4);
      const ambient = new THREE.AmbientLight(0xffffff, 0.42);
      scene.add(key, fill, ambient);
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.1;
    controls.minDistance = 1.5;
    controls.maxDistance = 80;

    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // Render loop: only runs while this viewer is actually on screen and
    // the tab is visible. Every caller here (MiniThreeMoleculeViewer,
    // ThreeStructurePreview, SymmetryElementsViewer…) defaults
    // `controls.autoRotate` to true, so before this the loop ran forever,
    // full-speed, the instant a viewer mounted — including scrolled off
    // the bottom of a long page, or behind a modal, or in a background
    // tab. On a phone GPU that's most of what "lagging" was: several
    // invisible scenes still drawing every frame. Mirrors the same
    // IntersectionObserver + document.hidden gating HeroMolecule already
    // uses on the homepage.
    let raf = 0;
    let onScreen = true;
    let disposed = false;
    const clock = new THREE.Clock();
    const frame = () => {
      raf = 0;
      if (disposed || !onScreen || document.hidden) return;
      const dt = Math.min(clock.getDelta(), 0.1);
      controls.update();
      onFrameRef.current?.(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf && !disposed) {
        clock.getDelta(); // drop the paused-time gap so dt doesn't jump on resume
        raf = requestAnimationFrame(frame);
      }
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen) start();
      },
      { threshold: 0 }
    );
    io.observe(el);
    const onVisibility = () => {
      if (!document.hidden) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    setStatus('ready');
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
    };
    // Deliberately mount-once, matching use3DmolViewer's own hook — the
    // scene isn't meant to be torn down and rebuilt just because a caller
    // passed a new options object on some later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { sceneRef, cameraRef, rendererRef, controlsRef, status };
}