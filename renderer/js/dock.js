"use strict";

/* Ctrl+Shift drag: lift the island off the screen, drop it on any edge and
   let it change shape. Horizontal capsules sit on the top/bottom edge,
   vertical capsules on the left/right edge, and the island snaps to the
   centre or the corners of every edge. */
(() => {
  const DI = window.DI;
  const $ = DI.$;

  const EDGE_THRESHOLD = 120; // px from an edge before it docks to it
  const SNAP_THRESHOLD = 110; // px to pull into a snap slot
  const VERTICAL_EDGES = new Set(["left", "right"]);
  const EDGE_LABEL = {
    top: "TOP EDGE",
    bottom: "BOTTOM EDGE",
    left: "LEFT EDGE",
    right: "RIGHT EDGE",
  };

  let workArea = { x: 0, y: 0, width: 1600, height: 900 };
  let dragging = false;
  let grab = { x: 0, y: 0 };
  let lastDrag = { x: 0, y: 0 };
  let pending = null;
  let hintShown = false;

  const isVerticalEdge = (edge) => VERTICAL_EDGES.has(edge);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  async function loadWorkArea() {
    try {
      const area = await DI.api?.getWorkArea?.();
      if (area && area.width) workArea = area;
    } catch {}
  }

  /* Snap slots along an edge: the two corners, the two quarter points and
     the centre. */
  function slotsFor(edge, span) {
    const limit = Math.max(0, 1 - span / (isVerticalEdge(edge) ? workArea.height : workArea.width));
    return [-limit, -limit * 0.5, 0, limit * 0.5, limit];
  }

  function nearestSlot(edge, offset, span) {
    const slots = slotsFor(edge, span);
    let best = slots[0];
    let bestDistance = Infinity;
    for (const slot of slots) {
      const distance = Math.abs(slot - offset);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
    return best;
  }

  function computeTarget(screenX, screenY, span) {
    const distances = {
      top: screenY - workArea.y,
      bottom: workArea.y + workArea.height - screenY,
      left: screenX - workArea.x,
      right: workArea.x + workArea.width - screenX,
    };
    let edge = null;
    let closest = Infinity;
    for (const [name, value] of Object.entries(distances)) {
      if (value < closest) {
        closest = value;
        edge = name;
      }
    }
    if (!edge || closest > EDGE_THRESHOLD) return null;

    const vertical = isVerticalEdge(edge);
    const along = vertical ? screenY : screenX;
    const center = vertical
      ? workArea.y + workArea.height / 2
      : workArea.x + workArea.width / 2;
    const half = vertical ? workArea.height / 2 : workArea.width / 2;
    const raw = clamp((along - center) / half, -1, 1);
    const slot = nearestSlot(edge, raw, span);
    // Only pull into a slot when the pointer is close enough to it.
    const pixels = Math.abs(slot - raw) * half;
    return { edge, offset: pixels <= SNAP_THRESHOLD ? slot : raw };
  }

  function islandSize() {
    const compact = $("#compact");
    if (!compact) return { width: 256, height: 42, vertical: false };
    const vertical = compact.classList.contains("is-vertical");
    return {
      width: compact.offsetWidth || 256,
      height: compact.offsetHeight || 42,
      vertical,
    };
  }

  const size0Vertical = () => Boolean($("#compact")?.classList.contains("is-vertical"));

  function showHint(edge) {
    const hint = $("#dockHint");
    if (!hint) return;
    if (edge) {
      hint.textContent = EDGE_LABEL[edge] || "";
      hint.style.display = "";
    } else {
      hint.style.display = "none";
    }
    hintShown = Boolean(edge);
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    if (!event.ctrlKey || !event.shiftKey) {
      // A normal press clears any leftover drag guard.
      DI.suppressIslandClick?.(0);
      return;
    }
    const compact = $("#compact");
    if (!compact || !compact.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    compact.classList.add("is-dragging");
    document.body.classList.add("is-dragging-island");
    grab.x = event.screenX - window.screenX;
    grab.y = event.screenY - window.screenY;
    DI.api?.setDragging?.(true);
    moveTo(event.screenX, event.screenY);
  }

  function moveTo(screenX, screenY) {
    const size = islandSize();
    const span = size.vertical ? size.height : size.width;
    const next = computeTarget(screenX, screenY, span);
    pending = next;
    showHint(next?.edge || null);
    DI.api?.dragMove?.({
      x: Math.round(screenX - grab.x),
      y: Math.round(screenY - grab.y),
    });
  }

  function onMouseMove(event) {
    if (dragging) {
      moveTo(event.screenX, event.screenY);
      return;
    }
    // Ctrl+Shift over the island arms the grab cursor.
    const compact = $("#compact");
    if (!compact) return;
    const armed = event.ctrlKey && event.shiftKey && compact.contains(event.target);
    compact.classList.toggle("is-grabbable", armed);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    // The click that follows the drop must not open the dashboard.
    DI.suppressIslandClick?.(450);
    const compact = $("#compact");
    compact?.classList.remove("is-dragging");
    document.body.classList.remove("is-dragging-island");
    showHint(null);
    DI.api?.setDragging?.(false);

    const target = pending;
    pending = null;
    if (target) {
      const vertical = isVerticalEdge(target.edge);
      compact?.classList.toggle("is-vertical", vertical);
      const size = DI.pillSizeFor?.(vertical) || { width: 42, height: 256 };
      const box = DI.windowBoxFor?.(size.width, size.height, vertical) || size;
      DI.api?.setDock?.({
        mode: "edge",
        edge: target.edge,
        offset: target.offset,
        width: box.width,
        height: box.height,
        animate: true,
      });
      DI.onIslandDocked?.(target.edge, target.offset);
      return;
    }

    const size = DI.pillSizeFor?.(size0Vertical()) || { width: 256, height: 42 };
    const box = DI.windowBoxFor?.(size.width, size.height, size.vertical) || size;
    DI.api?.setDock?.({
      mode: "free",
      x: window.screenX,
      y: window.screenY,
      width: box.width,
      height: box.height,
      animate: false,
    });
  }

  function applyDock(dock) {
    if (!dock) return;
    const vertical = dock.edge === "left" || dock.edge === "right";
    $("#compact")?.classList.toggle("is-vertical", vertical);
  }

  async function restoreDock() {
    try {
      const settings = await DI.api?.getSettings?.();
      applyDock(settings?.dock);
    } catch {}
  }

  function initDock() {
    loadWorkArea();
    restoreDock();
    window.addEventListener("resize", loadWorkArea);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", () => {
      if (!dragging) return;
      onMouseUp();
    });
  }

  DI.initDock = initDock;
  DI.inits.push(initDock);

  /* Pointer-tracked specular sweep inside the panel (light only — nothing
     moves with the mouse). */
  function initPanelPointer() {
    const panel = $("#panel");
    if (!panel) return;
    let raf = 0;
    panel.addEventListener("pointermove", (event) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = panel.getBoundingClientRect();
        const px = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
        const py = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
        panel.style.setProperty("--px", px.toFixed(3));
        panel.style.setProperty("--py", py.toFixed(3));
      });
    });
    panel.addEventListener("pointerleave", () => {
      panel.style.setProperty("--px", "0");
      panel.style.setProperty("--py", "0");
    });
  }
  DI.inits.push(initPanelPointer);

  /* The tray can send the island back to the top centre. */
  DI.api?.onResetDock?.(() => {
    $("#compact")?.classList.remove("is-vertical");
  });
})();
