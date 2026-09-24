import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf;
    const clock = new THREE.Clock();
    const loop = () => {
      const dt = Math.min(clock.getDelta(), 0.1);
      controls.update();
      onFrameRef.current?.(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    setStatus('ready');

    return () => {
      cancelAnimationFrame(raf);
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