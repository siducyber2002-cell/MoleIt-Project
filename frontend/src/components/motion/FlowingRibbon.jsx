// frontend/src/components/motion/FlowingRibbon.jsx
//
// A twisted, flowing gradient ribbon — two colour "faces" (a cool blue
// and a warm amber) that share one wavy centerline, with each face's
// thickness modulated in and out of phase so the band reads as a
// single twisting strip alternately showing one colour then the
// other, finished with a soft film-grain overlay.
//
// This is a from-scratch canvas animation (no external assets, no
// borrowed code) built to land in the same visual territory as
// handhold.io's hero — cool/warm twisted ribbon + grain — retuned for
// a light page background and a lower opacity so page copy stays
// legible where it overlaps.

import { useEffect, useRef } from 'react';

export default function FlowingRibbon({ className = '', height = 220, opacity = 1 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // One small noise tile, generated once and reused as a repeating
    // pattern — cheap grain instead of per-pixel work every frame.
    const tileSize = 96;
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = tileSize;
    noiseCanvas.height = tileSize;
    const nctx = noiseCanvas.getContext('2d');
    const imgData = nctx.createImageData(tileSize, tileSize);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255;
      imgData.data[i] = v;
      imgData.data[i + 1] = v;
      imgData.data[i + 2] = v;
      imgData.data[i + 3] = 255;
    }
    nctx.putImageData(imgData, 0, 0);
    const grainPattern = ctx.createPattern(noiseCanvas, 'repeat');

    let width = 0;
    let raf = 0;
    let onScreen = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const midY = height * 0.52;

    function drawBand(t, colorFrom, colorMid, phase, twistOffset, periodPx, ampScale) {
      const steps = 120;
      const top = [];
      const bottom = [];
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * width;
        const twist = Math.cos(x / periodPx + t + twistOffset);
        // Higher floor (0.32, not a near-zero pinch) so the band reads
        // as one bold, continuously-visible ribbon that twists between
        // two colours, rather than thinning to a sliver — a wide sweep
        // like the reference, not a thread.
        const thickness = height * 0.5 * ampScale * Math.max(0.32, Math.abs(twist));
        const y = midY + Math.sin(x / (periodPx * 1.3) + t * 0.55 + phase) * height * 0.14;
        top.push([x, y - thickness / 2]);
        bottom.push([x, y + thickness / 2]);
      }
      ctx.beginPath();
      top.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0, colorFrom);
      grad.addColorStop(0.5, colorMid);
      grad.addColorStop(1, colorFrom);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    function frame(ts) {
      raf = 0;
      if (!onScreen) return;
      ctx.clearRect(0, 0, width, height);
      const t = reduceMotion ? 0 : ts / 3400;

      ctx.globalAlpha = 0.85;
      drawBand(t, '#cfe6ff', '#3f7fe0', 0, 0, 620, 1);
      ctx.globalAlpha = 0.8;
      drawBand(t, '#ffe4b3', '#e2872e', 0.9, Math.PI / 2, 560, 0.92);
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = grainPattern;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      if (!reduceMotion) raf = requestAnimationFrame(frame);
    }

    // Only redraw while the ribbon is actually scrolled into view — it was
    // previously redrawing every frame forever regardless of scroll
    // position, which adds up on a phone when it's just one of several
    // animations running on the page at once.
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen && !raf) raf = requestAnimationFrame(frame);
      },
      { threshold: 0 }
    );
    io.observe(canvas);

    raf = requestAnimationFrame(frame);
    if (reduceMotion) frame(0);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [height]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height, display: 'block', opacity }}
      aria-hidden="true"
    />
  );
}