import { useRef, useState, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize, FlaskConical } from 'lucide-react';
import { elementInfo, newAtomId, newBondId } from '../../lib/elements';
import { insertRing } from '../../api/api';

const ATOM_HIT_RADIUS = 16;
const NEW_BOND_ORDER = 1;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const FIT_PADDING = 70; // world-space margin kept around a structure when fitting it to view

const STYLE_CYCLE = { none: 'wedge', wedge: 'dash', dash: 'aromatic', aromatic: 'none' };

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let t = lenSq !== 0 ? dot / lenSq : -1;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * C, projY = y1 + t * D;
  return Math.hypot(px - projX, py - projY);
}

function eraseAtPoint(pos, draftAtoms, draftBonds, radius) {
  const atomsToRemove = new Set(
    draftAtoms.filter((a) => Math.hypot(a.x - pos.x, a.y - pos.y) <= radius).map((a) => a.id)
  );
  const survivingAtoms = draftAtoms.filter((a) => !atomsToRemove.has(a.id));
  const nextBonds = draftBonds.filter((b) => {
    if (atomsToRemove.has(b.from) || atomsToRemove.has(b.to)) return false;
    const from = draftAtoms.find((a) => a.id === b.from);
    const to = draftAtoms.find((a) => a.id === b.to);
    if (!from || !to) return false;
    return distToSegment(pos.x, pos.y, from.x, from.y, to.x, to.y) > radius * 0.6;
  });
  return { atoms: survivingAtoms, bonds: nextBonds };
}

/** Computes the zoom/pan that centers `atomList` inside a viewport of the
 *  given pixel size, with some breathing room around it. Used both for the
 *  "fit to structure" button and to auto-center anything freshly imported
 *  (from the library, functional groups, or a SMILES import) so it never
 *  lands pinned in a corner or clipped, regardless of what coordinate
 *  range the source used. */
function computeFitTransform(atomList, viewportWidth, viewportHeight) {
  if (!atomList.length || !viewportWidth || !viewportHeight) {
    return { zoom: 1, pan: { x: 0, y: 0 } };
  }
  const xs = atomList.map((a) => a.x);
  const ys = atomList.map((a) => a.y);
  const minX = Math.min(...xs) - FIT_PADDING;
  const maxX = Math.max(...xs) + FIT_PADDING;
  const minY = Math.min(...ys) - FIT_PADDING;
  const maxY = Math.max(...ys) + FIT_PADDING;
  const boxW = Math.max(maxX - minX, 40);
  const boxH = Math.max(maxY - minY, 40);
  const zoom = clamp(Math.min(viewportWidth / boxW, viewportHeight / boxH), MIN_ZOOM, MAX_ZOOM);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const pan = { x: viewportWidth / 2 - centerX * zoom, y: viewportHeight / 2 - centerY * zoom };
  return { zoom, pan };
}

export default function DrawCanvas({
  atoms,
  bonds,
  onChange,
  activeElement,
  activeTool,
  atomScale = 1,
  ringType = 'benzene',
  eraserSize = 18,
  onSelect,
  invalidAtomIds = null,
  fitSignal,
  onSelectionChange,
}) {
  const svgRef = useRef(null);
  // Coalesces pointermove-driven state updates to one per animation frame.
  // Without this, `handleSvgMouseMove` below (setState + O(atoms)/O(bonds)
  // hit-testing) ran once per native pointermove event — on a desktop mouse
  // that's already roughly frame-rate, but Android's touch layer samples
  // pointermove far more often than the screen can even redraw, so every
  // drag/hover on a phone was queuing up several React re-renders per
  // frame. Capping it here to `requestAnimationFrame` makes this handler
  // (and the window-level pan handler further down) actually run at the
  // display's frame rate on every device, not just fast desktops.
  const pendingSvgMove = useRef(null);
  const svgMoveRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(svgMoveRaf.current), []);
  const [dragBondFrom, setDragBondFrom] = useState(null);
  const [dragBondPos, setDragBondPos] = useState(null);
  const [hoverAtom, setHoverAtom] = useState(null);
  const [hoverBond, setHoverBond] = useState(null);
  const [pointerPos, setPointerPos] = useState(null);

  const [dragAtomPreview, setDragAtomPreview] = useState(null);
  const [dragBondMovePreview, setDragBondMovePreview] = useState(null);
  const dragBondMoveStart = useRef(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);

  // Select tool: rubber-band an area, then drag the whole selection.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [marquee, setMarquee] = useState(null); // {x1,y1,x2,y2} in world coords
  const marqueeStart = useRef(null);
  const [groupMovePreview, setGroupMovePreview] = useState(null); // {dx,dy}
  const groupMoveStart = useRef(null);

  const eraseDraftRef = useRef(null);
  const [isErasing, setIsErasing] = useState(false);
  const [, setEraseTick] = useState(0);

  const toSvgCoords = useCallback(
    (e) => {
      const svg = svgRef.current;
      const rect = svg.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      return { x: (screenX - pan.x) / zoom, y: (screenY - pan.y) / zoom };
    },
    [pan, zoom]
  );

  const handleWheelNative = useCallback((e) => {
    e.preventDefault();
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((prevZoom) => {
      const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM);
      setPan((prevPan) => {
        const worldX = (screenX - prevPan.x) / prevZoom;
        const worldY = (screenY - prevPan.y) / prevZoom;
        return { x: screenX - worldX * nextZoom, y: screenY - worldY * nextZoom };
      });
      return nextZoom;
    });
  }, []);

  // React attaches onWheel as a *passive* listener, which silently makes
  // e.preventDefault() a no-op — the page scrolls underneath the canvas at
  // the same time it tries to zoom, so the content you're zoomed in on
  // (and whatever's under your cursor) visibly drifts out from under you.
  // A native listener with { passive: false } is the only reliable fix.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheelNative);
  }, [handleWheelNative]);

  const zoomBy = (factor) => {
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setZoom((prevZoom) => {
      const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM);
      setPan((prevPan) => {
        const worldX = (cx - prevPan.x) / prevZoom;
        const worldY = (cy - prevPan.y) / prevZoom;
        return { x: cx - worldX * nextZoom, y: cy - worldY * nextZoom };
      });
      return nextZoom;
    });
  };

  const fitToAtoms = useCallback((atomList) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const { zoom: z, pan: p } = computeFitTransform(atomList, rect.width, rect.height);
    setZoom(z);
    setPan(p);
  }, []);

  // "Fit to structure" — centers and zooms so the whole molecule is
  // visible, instead of a hard reset to zoom 1 / pan 0,0 (which is what
  // used to leave a freshly imported structure stuck wherever its raw
  // coordinates happened to fall, sometimes clipped in a corner).
  const resetView = () => {
    if (atoms.length) fitToAtoms(atoms);
    else {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  };

  // Whenever the parent bumps fitSignal (a fresh structure was loaded from
  // the library, functional groups, a SMILES import, or Autocorrect ran),
  // re-center the view on whatever's on the canvas now. requestAnimationFrame
  // ensures the SVG has its real on-screen size by the time we measure it.
  useEffect(() => {
    if (fitSignal === undefined) return;
    const frame = requestAnimationFrame(() => fitToAtoms(atoms));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  // Space-to-pan (held anywhere, doesn't need a tool switch), the usual
  // convention in drawing/design tools. Ignored while typing in a field.
  useEffect(() => {
    const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const down = (e) => {
      if (e.code === 'Space' && !isTyping(document.activeElement)) {
        setIsSpaceDown(true);
      }
    };
    const up = (e) => {
      if (e.code === 'Space') setIsSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Robust panning: bind to the window (not just the SVG) while active, so
  // a fast drag that leaves the canvas bounds doesn't get "stuck". Pointer
  // events (not mouse events) so this works for touch/pen too, not just
  // a mouse — touchmove doesn't synthesize continuous mousemove events, so
  // a drag-based tool like this needs pointer events to work on a phone.
  useEffect(() => {
    if (!isPanning) return;
    // Same one-update-per-frame coalescing as handleSvgMouseMove — this
    // listens on `window` (so a fast pan drag that leaves the canvas
    // doesn't get stuck), which means it also sees every native
    // pointermove sample directly, unthrottled by React's own batching.
    let raf = 0;
    let pending = null;
    const move = (e) => {
      if (!panStart.current) return;
      pending = { clientX: e.clientX, clientY: e.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!pending || !panStart.current) return;
        setPan({
          x: panStart.current.panX + (pending.clientX - panStart.current.x),
          y: panStart.current.panY + (pending.clientY - panStart.current.y),
        });
      });
    };
    const up = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      setIsPanning(false);
      panStart.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [isPanning]);

  // Leaving the select tool (or the structure changing under it) clears
  // any stale selection.
  useEffect(() => {
    if (activeTool !== 'select') {
      setSelectedIds(new Set());
      setMarquee(null);
      marqueeStart.current = null;
    }
  }, [activeTool]);

  // Keep the parent (DrawLabPage) in sync with what's currently
  // box-selected, so features like the structure recognizer know whether
  // to work on a "cropped" region or the whole canvas.
  useEffect(() => {
    onSelectionChange?.(selectedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // Delete/Backspace removes a selection; Escape clears it.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (activeTool !== 'select' || selectedIds.size === 0) return;
      const isTyping =
        document.activeElement &&
        (document.activeElement.tagName === 'INPUT' ||
          document.activeElement.tagName === 'TEXTAREA' ||
          document.activeElement.isContentEditable);
      if (isTyping) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onChange(
          atoms.filter((a) => !selectedIds.has(a.id)),
          bonds.filter((b) => !selectedIds.has(b.from) && !selectedIds.has(b.to))
        );
        setSelectedIds(new Set());
      } else if (e.key === 'Escape') {
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, selectedIds, atoms, bonds, onChange]);

  const displayAtoms = useCallback(() => {
    if (dragAtomPreview) {
      return atoms.map((a) => (a.id === dragAtomPreview.id ? { ...a, x: dragAtomPreview.x, y: dragAtomPreview.y } : a));
    }
    if (dragBondMovePreview) {
      const { fromId, toId, dx, dy } = dragBondMovePreview;
      return atoms.map((a) =>
        a.id === fromId || a.id === toId ? { ...a, x: a.x + dx, y: a.y + dy } : a
      );
    }
    if (groupMovePreview) {
      const { dx, dy } = groupMovePreview;
      return atoms.map((a) => (selectedIds.has(a.id) ? { ...a, x: a.x + dx, y: a.y + dy } : a));
    }
    return atoms;
  }, [atoms, dragAtomPreview, dragBondMovePreview, groupMovePreview, selectedIds]);

  const findAtomAt = useCallback(
    (pos, list) => (list || atoms).find((a) => Math.hypot(a.x - pos.x, a.y - pos.y) <= ATOM_HIT_RADIUS * atomScale),
    [atoms, atomScale]
  );

  const BOND_HIT_DISTANCE = 7;
  const findBondAt = useCallback(
    (pos, atomList) => {
      const list = atomList || atoms;
      for (const b of bonds) {
        const from = list.find((a) => a.id === b.from);
        const to = list.find((a) => a.id === b.to);
        if (!from || !to) continue;
        if (distToSegment(pos.x, pos.y, from.x, from.y, to.x, to.y) <= BOND_HIT_DISTANCE) return b;
      }
      return null;
    },
    [atoms, bonds]
  );

  const startErase = (pos) => {
    eraseDraftRef.current = eraseAtPoint(pos, atoms, bonds, eraserSize);
    setEraseTick((t) => t + 1);
    setIsErasing(true);
  };
  const continueErase = (pos) => {
    if (!eraseDraftRef.current) return;
    eraseDraftRef.current = eraseAtPoint(pos, eraseDraftRef.current.atoms, eraseDraftRef.current.bonds, eraserSize);
    setEraseTick((t) => t + 1);
  };
  const finishErase = () => {
    if (eraseDraftRef.current) {
      onChange(eraseDraftRef.current.atoms, eraseDraftRef.current.bonds);
    }
    eraseDraftRef.current = null;
    setIsErasing(false);
  };

  const addAtom = (x, y, element) => {
    const id = newAtomId(atoms);
    onChange([...atoms, { id, element, x, y, charge: 0, lonePairs: 0 }], bonds);
  };

  const addRing = (x, y) => {
    // Fire-and-forget async — the click handler itself stays sync (React
    // event handlers don't need to be awaited), the canvas just commits
    // the result once the backend responds instead of computing it
    // in-place the way lib/ringTemplates.js's (now-removed)
    // generateRingStructure used to.
    insertRing(ringType, x, y, atoms, bonds)
      .then(({ atoms: nextAtoms, bonds: nextBonds }) => onChange(nextAtoms, nextBonds))
      .catch(() => {}); // best-effort — a dropped ring-insert on a network blip isn't worth surfacing an error toast over
  };

  const addOrCycleBond = (fromId, toId) => {
    if (fromId === toId) return;
    const existing = bonds.find(
      (b) => (b.from === fromId && b.to === toId) || (b.from === toId && b.to === fromId)
    );
    if (existing) {
      cycleBondOrder(existing.id);
    } else {
      const id = newBondId(bonds);
      onChange(atoms, [...bonds, { id, from: fromId, to: toId, order: NEW_BOND_ORDER, aromatic: false, style: 'none' }]);
    }
  };

  const cycleBondOrder = (bondId) => {
    onChange(
      atoms,
      bonds.map((b) => {
        if (b.id !== bondId) return b;
        if (b.style && b.style !== 'none') {
          return { ...b, style: 'none', aromatic: false };
        }
        return { ...b, order: b.order >= 3 ? 1 : b.order + 1 };
      })
    );
  };

  const cycleBondStyle = (bondId) => {
    onChange(
      atoms,
      bonds.map((b) => {
        if (b.id !== bondId) return b;
        const current = b.style || (b.aromatic ? 'aromatic' : 'none');
        const next = STYLE_CYCLE[current];
        if (next === 'wedge' || next === 'dash') {
          return { ...b, style: next, order: 1, aromatic: false };
        }
        if (next === 'aromatic') {
          return { ...b, style: 'aromatic', aromatic: true };
        }
        return { ...b, style: 'none', aromatic: false };
      })
    );
  };

  const toggleLonePair = (atomId) => {
    onChange(
      atoms.map((a) => (a.id === atomId ? { ...a, lonePairs: ((a.lonePairs || 0) + 1) % 5 } : a)),
      bonds
    );
  };

  const bumpCharge = (atomId, delta) => {
    onChange(
      atoms.map((a) =>
        a.id === atomId
          ? { ...a, charge: Math.max(-9, Math.min(9, (a.charge || 0) + delta)) }
          : a
      ),
      bonds
    );
  };

  // Any of: middle-click, the dedicated Pan tool, or Space held down + left
  // click starts a canvas pan. Checked first in every mousedown handler
  // (svg background, an atom, or a bond) so panning always works no matter
  // what's under the cursor.
  const tryStartPan = (e) => {
    const wantsPan = e.button === 1 || activeTool === 'pan' || (isSpaceDown && e.button === 0);
    if (!wantsPan) return false;
    e.preventDefault();
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
    return true;
  };

  const handleAtomMouseDown = (e, atom) => {
    if (tryStartPan(e)) return;
    e.stopPropagation();
    onSelect?.({ type: 'atom', id: atom.id });

    if (activeTool === 'select') {
      const pos = toSvgCoords(e);
      if (!selectedIds.has(atom.id)) setSelectedIds(new Set([atom.id]));
      groupMoveStart.current = pos;
      setGroupMovePreview({ dx: 0, dy: 0 });
      return;
    }

    if (activeTool === 'erase') return startErase({ x: atom.x, y: atom.y });
    if (activeTool === 'lonepair') return toggleLonePair(atom.id);
    if (activeTool === 'charge+') return bumpCharge(atom.id, 1);
    if (activeTool === 'charge-') return bumpCharge(atom.id, -1);

    if (activeTool === 'bond') {
      setDragBondFrom(atom.id);
      setDragBondPos({ x: atom.x, y: atom.y });
      return;
    }

    if (activeTool === 'atom' || activeTool === 'ring') {
      if (activeTool === 'atom' && activeElement && activeElement !== atom.element) {
        onChange(atoms.map((a) => (a.id === atom.id ? { ...a, element: activeElement } : a)), bonds);
      }
      setDragAtomPreview({ id: atom.id, x: atom.x, y: atom.y });
    }
  };

  const handleBondMouseDown = (e, bond) => {
    if (tryStartPan(e)) return;
    e.stopPropagation();
    onSelect?.({ type: 'bond', id: bond.id });

    if (e.button === 2) {
      cycleBondStyle(bond.id);
      return;
    }

    if (activeTool === 'select') {
      const pos = toSvgCoords(e);
      const ids = new Set([bond.from, bond.to]);
      const alreadySelected = [...ids].every((id) => selectedIds.has(id));
      setSelectedIds(alreadySelected ? selectedIds : ids);
      groupMoveStart.current = pos;
      setGroupMovePreview({ dx: 0, dy: 0 });
      return;
    }

    if (activeTool === 'erase') return startErase(toSvgCoords(e));
    if (activeTool === 'bond') return cycleBondOrder(bond.id);
    if (activeTool === 'atom' || activeTool === 'ring') {
      const pos = toSvgCoords(e);
      dragBondMoveStart.current = { x: pos.x, y: pos.y, fromId: bond.from, toId: bond.to };
      setDragBondMovePreview({ fromId: bond.from, toId: bond.to, dx: 0, dy: 0 });
    }
  };

  const handleSvgMouseDown = (e) => {
    if (tryStartPan(e)) return;
    if (activeTool === 'erase' && e.button === 0) {
      startErase(toSvgCoords(e));
      return;
    }
    if (activeTool === 'select' && e.button === 0) {
      const pos = toSvgCoords(e);
      marqueeStart.current = pos;
      setMarquee({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
    }
  };

  // The actual work, run at most once per animation frame — see the
  // `svgMoveRaf` comment above.
  const processSvgMove = (clientX, clientY) => {
    const pos = toSvgCoords({ clientX, clientY });
    setPointerPos(pos);
    if (marqueeStart.current) {
      setMarquee({ x1: marqueeStart.current.x, y1: marqueeStart.current.y, x2: pos.x, y2: pos.y });
      return;
    }
    if (groupMoveStart.current) {
      setGroupMovePreview({ dx: pos.x - groupMoveStart.current.x, dy: pos.y - groupMoveStart.current.y });
      return;
    }
    if (isErasing) {
      continueErase(pos);
    } else if (dragBondFrom) {
      setDragBondPos(pos);
      const hovered = findAtomAt(pos);
      setHoverAtom(hovered ? hovered.id : null);
    } else if (dragAtomPreview) {
      setDragAtomPreview((prev) => ({ ...prev, x: pos.x, y: pos.y }));
    } else if (dragBondMovePreview && dragBondMoveStart.current) {
      const { x, y, fromId, toId } = dragBondMoveStart.current;
      setDragBondMovePreview({ fromId, toId, dx: pos.x - x, dy: pos.y - y });
    } else if (!isPanning) {
      // Idle — general hover feedback so it's always clear what a click
      // would land on, at any zoom level and with any tool selected.
      const hoveredAtom = findAtomAt(pos);
      if (hoveredAtom) {
        setHoverAtom(hoveredAtom.id);
        setHoverBond(null);
      } else {
        setHoverAtom(null);
        setHoverBond(activeTool === 'pan' ? null : findBondAt(pos)?.id ?? null);
      }
    }
  };

  const handleSvgMouseMove = (e) => {
    // Pull the only two fields we need off the (React 19, unpooled)
    // synthetic event synchronously — cheap — and defer the expensive
    // hit-testing/setState work to the next frame.
    pendingSvgMove.current = { clientX: e.clientX, clientY: e.clientY };
    if (svgMoveRaf.current) return;
    svgMoveRaf.current = requestAnimationFrame(() => {
      svgMoveRaf.current = 0;
      const p = pendingSvgMove.current;
      if (p) processSvgMove(p.clientX, p.clientY);
    });
  };

  const finishMarquee = () => {
    if (marquee) {
      const x1 = Math.min(marquee.x1, marquee.x2), x2 = Math.max(marquee.x1, marquee.x2);
      const y1 = Math.min(marquee.y1, marquee.y2), y2 = Math.max(marquee.y1, marquee.y2);
      const within = atoms.filter((a) => a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2).map((a) => a.id);
      setSelectedIds(new Set(within));
    }
    setMarquee(null);
    marqueeStart.current = null;
  };

  const finishGroupMove = () => {
    if (groupMovePreview) {
      const { dx, dy } = groupMovePreview;
      if (dx !== 0 || dy !== 0) {
        onChange(
          atoms.map((a) => (selectedIds.has(a.id) ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
          bonds
        );
      }
    }
    setGroupMovePreview(null);
    groupMoveStart.current = null;
  };

  const handleSvgMouseLeave = () => {
    // Drop any queued frame from a move that's now stale (the cursor's
    // left the canvas), so it can't fire after the state below resets.
    cancelAnimationFrame(svgMoveRaf.current);
    svgMoveRaf.current = 0;
    setPointerPos(null);
    setHoverAtom(null);
    setHoverBond(null);
    if (isErasing) finishErase();
  };

  const handleSvgMouseUp = (e) => {
    // Same reasoning: whatever's about to be committed below should win
    // over a stale mid-drag frame that just happens to fire afterward.
    cancelAnimationFrame(svgMoveRaf.current);
    svgMoveRaf.current = 0;
    if (marqueeStart.current) {
      finishMarquee();
      return;
    }
    if (groupMoveStart.current) {
      finishGroupMove();
      return;
    }
    const pos = toSvgCoords(e);
    if (isErasing) {
      finishErase();
      return;
    }
    if (dragBondFrom) {
      const target = findAtomAt(pos);
      const from = atoms.find((a) => a.id === dragBondFrom);
      const dist = from ? Math.hypot(from.x - pos.x, from.y - pos.y) : 0;
      if (target && target.id !== dragBondFrom) {
        addOrCycleBond(dragBondFrom, target.id);
      } else if (!target && dist > 12) {
        const newId = newAtomId(atoms);
        const bondId = newBondId(bonds);
        onChange(
          [...atoms, { id: newId, element: activeElement || 'C', x: pos.x, y: pos.y, charge: 0, lonePairs: 0 }],
          [...bonds, { id: bondId, from: dragBondFrom, to: newId, order: NEW_BOND_ORDER, aromatic: false, style: 'none' }]
        );
      }
      setDragBondFrom(null);
      setDragBondPos(null);
      setHoverAtom(null);
    }
    if (dragAtomPreview) {
      onChange(
        atoms.map((a) => (a.id === dragAtomPreview.id ? { ...a, x: dragAtomPreview.x, y: dragAtomPreview.y } : a)),
        bonds
      );
      setDragAtomPreview(null);
    }
    if (dragBondMovePreview) {
      const { fromId, toId, dx, dy } = dragBondMovePreview;
      onChange(
        atoms.map((a) => (a.id === fromId || a.id === toId ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
        bonds
      );
      setDragBondMovePreview(null);
      dragBondMoveStart.current = null;
    }
  };

  const handleSvgClick = (e) => {
    if (
      dragBondFrom || dragAtomPreview || dragBondMovePreview || isErasing || isPanning ||
      activeTool === 'select' || activeTool === 'pan'
    ) return;
    const pos = toSvgCoords(e);
    if (findAtomAt(pos)) return;
    if (activeTool === 'atom') addAtom(pos.x, pos.y, activeElement || 'C');
    if (activeTool === 'ring') addRing(pos.x, pos.y);
  };

  useEffect(() => {
    const up = () => {
      if (marqueeStart.current) {
        finishMarquee();
        return;
      }
      if (groupMoveStart.current) {
        finishGroupMove();
        return;
      }
      if (isErasing) {
        finishErase();
        return;
      }
      if (dragAtomPreview) {
        onChange(
          atoms.map((a) => (a.id === dragAtomPreview.id ? { ...a, x: dragAtomPreview.x, y: dragAtomPreview.y } : a)),
          bonds
        );
        setDragAtomPreview(null);
      }
      if (dragBondMovePreview) {
        const { fromId, toId, dx, dy } = dragBondMovePreview;
        onChange(
          atoms.map((a) => (a.id === fromId || a.id === toId ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
          bonds
        );
        setDragBondMovePreview(null);
        dragBondMoveStart.current = null;
      }
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isErasing, dragAtomPreview, dragBondMovePreview, marquee, groupMovePreview, selectedIds, atoms, bonds]);

  const shownAtoms = eraseDraftRef.current ? eraseDraftRef.current.atoms : displayAtoms();
  const shownBonds = eraseDraftRef.current ? eraseDraftRef.current.bonds : bonds;
  const isDragTool = activeTool === 'atom' || activeTool === 'ring' || activeTool === 'select';

  const cursorClass = isPanning
    ? 'cursor-grabbing'
    : activeTool === 'pan' || isSpaceDown
    ? 'cursor-grab'
    : activeTool === 'ring'
    ? 'cursor-copy'
    : activeTool === 'erase'
    ? 'cursor-none'
    : activeTool === 'select'
    ? 'cursor-default'
    : 'cursor-crosshair';

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        className={`h-full w-full grid-paper select-none touch-none ${cursorClass}`}
        onPointerDown={handleSvgMouseDown}
        onPointerMove={handleSvgMouseMove}
        onPointerUp={handleSvgMouseUp}
        onPointerLeave={handleSvgMouseLeave}
        onClick={handleSvgClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {shownBonds.map((bond) => {
            const from = shownAtoms.find((a) => a.id === bond.from);
            const to = shownAtoms.find((a) => a.id === bond.to);
            if (!from || !to) return null;
            return (
              <BondLine
                key={bond.id}
                from={from}
                to={to}
                order={bond.order}
                aromatic={bond.aromatic}
                style={bond.style}
                highlighted={hoverBond === bond.id}
                draggable={isDragTool}
                onMouseDown={(e) => handleBondMouseDown(e, bond)}
              />
            );
          })}

          {dragBondFrom &&
            dragBondPos &&
            (() => {
              const from = shownAtoms.find((a) => a.id === dragBondFrom);
              if (!from) return null;
              return (
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={dragBondPos.x}
                  y2={dragBondPos.y}
                  stroke="var(--color-phosphor)"
                  strokeWidth={2 / zoom}
                  strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                  pointerEvents="none"
                />
              );
            })()}

          {shownAtoms.map((atom) => (
            <AtomNode
              key={atom.id}
              atom={atom}
              highlighted={hoverAtom === atom.id}
              invalid={invalidAtomIds?.has(atom.id)}
              selected={selectedIds.has(atom.id)}
              draggable={isDragTool}
              onMouseDown={(e) => handleAtomMouseDown(e, atoms.find((a) => a.id === atom.id) || atom)}
              scale={atomScale}
            />
          ))}

          {activeTool === 'erase' && pointerPos && (
            <circle
              cx={pointerPos.x}
              cy={pointerPos.y}
              r={eraserSize}
              fill="rgba(251,113,133,0.10)"
              stroke="var(--color-coral)"
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${3 / zoom} ${3 / zoom}`}
              pointerEvents="none"
            />
          )}

          {marquee && (
            <rect
              x={Math.min(marquee.x1, marquee.x2)}
              y={Math.min(marquee.y1, marquee.y2)}
              width={Math.abs(marquee.x2 - marquee.x1)}
              height={Math.abs(marquee.y2 - marquee.y1)}
              fill="rgba(56,189,248,0.10)"
              stroke="#38bdf8"
              strokeWidth={1.2 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>

      {atoms.length === 0 && (
        // An HTML overlay, not SVG content inside the pan/zoom transform —
        // that's the fix for this being off-center previously: SVG text
        // fixed at world coordinate (300,200) only lands in the visual
        // center when the canvas happens to be exactly 600x400px. This
        // stays centered in the actual rendered area at any size, zoom,
        // or pan.
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <FlaskConical size={28} className="text-lab-700" />
          <p className="font-mono text-sm text-lab-500">Click anywhere to place your first atom</p>
          <p className="text-xs text-lab-600">or pick a ring, import a SMILES string, or pull one in from the Library</p>
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-lab-700 bg-lab-900/90 p-1 shadow-lg backdrop-blur">
        <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out" className="rounded-md p-1.5 text-lab-300 hover:bg-lab-800 hover:text-lab-100">
          <ZoomOut size={14} />
        </button>
        <span className="w-10 text-center text-[11px] font-mono text-lab-400">{Math.round(zoom * 100)}%</span>
        <button onClick={() => zoomBy(1.2)} title="Zoom in" className="rounded-md p-1.5 text-lab-300 hover:bg-lab-800 hover:text-lab-100">
          <ZoomIn size={14} />
        </button>
        <button onClick={resetView} title="Fit to structure" className="rounded-md p-1.5 text-lab-300 hover:bg-lab-800 hover:text-lab-100">
          <Maximize size={14} />
        </button>
      </div>
      <p className="absolute bottom-3 right-3 text-right text-[10px] leading-snug text-lab-600">
        {activeTool === 'select'
          ? 'Drag to box-select \u00b7 drag a selection to move it \u00b7 Delete to remove'
          : 'Scroll to zoom \u00b7 hold Space (or the Pan tool) to drag the canvas'}
        <br />
        Right-click a bond: wedge → dash → aromatic
      </p>
    </div>
  );
}

function BondLine({ from, to, order, aromatic, style, onMouseDown, draggable, highlighted }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = -dy / len;
  const uy = dx / len;
  const gap = 4;
  const resolvedStyle = style || (aromatic ? 'aromatic' : 'none');
  const cursorClass = draggable ? 'cursor-move' : 'cursor-pointer';
  const strokeColor = highlighted ? 'var(--color-phosphor)' : '#c7d0d3';

  if (resolvedStyle === 'wedge') {
    const wide = 6;
    const points = `${from.x},${from.y} ${to.x + ux * wide},${to.y + uy * wide} ${to.x - ux * wide},${to.y - uy * wide}`;
    return (
      <g onPointerDown={onMouseDown} className={cursorClass}>
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={14} />
        <polygon points={points} fill={strokeColor} />
      </g>
    );
  }

  if (resolvedStyle === 'dash') {
    const segments = [];
    for (let i = 1; i <= 6; i++) {
      const t = i / 7;
      const px = from.x + dx * t;
      const py = from.y + dy * t;
      const w = 1.5 + (6 - 1.5) * t;
      segments.push([px + ux * w, py + uy * w, px - ux * w, py - uy * w]);
    }
    return (
      <g onPointerDown={onMouseDown} className={cursorClass}>
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={14} />
        {segments.map((s, i) => (
          <line key={i} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} stroke={strokeColor} strokeWidth={1.5} strokeLinecap="round" />
        ))}
      </g>
    );
  }

  const lines = [];
  if (order === 1 || resolvedStyle === 'aromatic') {
    lines.push([from.x, from.y, to.x, to.y]);
  }
  if (order === 2) {
    lines.push([from.x + ux * gap, from.y + uy * gap, to.x + ux * gap, to.y + uy * gap]);
    lines.push([from.x - ux * gap, from.y - uy * gap, to.x - ux * gap, to.y - uy * gap]);
  } else if (order === 3) {
    lines.push([from.x, from.y, to.x, to.y]);
    lines.push([from.x + ux * gap * 1.6, from.y + uy * gap * 1.6, to.x + ux * gap * 1.6, to.y + uy * gap * 1.6]);
    lines.push([from.x - ux * gap * 1.6, from.y - uy * gap * 1.6, to.x - ux * gap * 1.6, to.y - uy * gap * 1.6]);
  }

  return (
    <g onPointerDown={onMouseDown} className={cursorClass}>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={14} />
      {lines.map((l, i) => (
        <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke={strokeColor} strokeWidth={highlighted ? 2.5 : 2} strokeLinecap="round" />
      ))}
      {resolvedStyle === 'aromatic' && (
        <line
          x1={from.x + ux * gap}
          y1={from.y + uy * gap}
          x2={to.x + ux * gap}
          y2={to.y + uy * gap}
          stroke={strokeColor}
          strokeWidth={1.2}
          strokeDasharray="3 3"
          opacity={0.6}
        />
      )}
    </g>
  );
}

function AtomNode({ atom, onMouseDown, highlighted, invalid, selected, scale = 1, draggable }) {
  const info = elementInfo(atom.element);
  const charge = atom.charge || 0;
  const lonePairs = atom.lonePairs || 0;
  const radius = info.radius * scale;

  return (
    <g
      transform={`translate(${atom.x}, ${atom.y})`}
      onPointerDown={onMouseDown}
      className={draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
    >
      {selected && (
        <circle r={radius + 7 * scale} fill="rgba(56,189,248,0.14)" stroke="#38bdf8" strokeWidth={2} />
      )}
      {invalid && (
        <circle
          r={radius + 5 * scale}
          fill="none"
          stroke="var(--color-coral)"
          strokeWidth={1.5}
          strokeDasharray={`${3 * scale} ${2.5 * scale}`}
          className="warn-pulse-svg"
          opacity={0.85}
        />
      )}
      <circle r={radius} fill="#0f1518" stroke={highlighted ? 'var(--color-phosphor)' : invalid ? 'var(--color-coral)' : info.color} strokeWidth={highlighted || invalid ? 3 : 2} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={12 * scale} fontWeight={700} fill={info.color} className="font-mono pointer-events-none">
        {atom.element}
      </text>

      {invalid && (
        <g transform={`translate(${radius * 0.72}, ${-radius * 0.72})`} className="pointer-events-none">
          <circle r={7 * scale} fill="var(--color-coral)" />
          <text textAnchor="middle" dominantBaseline="central" fontSize={10 * scale} fontWeight={800} fill="#0f1518">!</text>
        </g>
      )}

      {charge !== 0 && (
        <text x={radius - 2} y={-radius + 2} fontSize={11 * scale} fontWeight={700} fill="var(--color-amber)" className="pointer-events-none">
          {charge > 0 ? `${charge > 1 ? charge : ''}+` : `${charge < -1 ? Math.abs(charge) : ''}-`}
        </text>
      )}

      {Array.from({ length: lonePairs }).map((_, i) => {
        const angle = (Math.PI / 2) * i - Math.PI / 2;
        const dist = radius + 7 * scale;
        const cx = Math.cos(angle) * dist;
        const cy = Math.sin(angle) * dist;
        const perpX = -Math.sin(angle) * 3.5 * scale;
        const perpY = Math.cos(angle) * 3.5 * scale;
        return (
          <g key={i} className="pointer-events-none">
            <circle cx={cx + perpX} cy={cy + perpY} r={1.6 * scale} fill="var(--color-violet)" />
            <circle cx={cx - perpX} cy={cy - perpY} r={1.6 * scale} fill="var(--color-violet)" />
          </g>
        );
      })}
    </g>
  );
}