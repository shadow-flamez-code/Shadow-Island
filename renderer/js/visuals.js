"use strict";

/* Visual layer: living capsule, drag trail, click ripples, liquid glass,
   holo accent drift, seconds ring, theme packs and swap-able capsule faces. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  const root = document.documentElement;
  let pulse = 0;
  let target = 0;
  let hueShift = 0;
  let hueTarget = 0;
  let rippleHost = null;

  /* ---------------------------------------------------------------- */
  /* Sound reactive capsule + holo accent                              */
  /* ---------------------------------------------------------------- */

  function watchAudio() {
    const tick = () => {
      const volume = state.bridge.volume || {};
      const level = Number(volume.level) || 0;
      const muted = Boolean(volume.muted);
      const active = Boolean(state.bridge.media?.active) && Boolean(state.bridge.media?.playing);
      target = active && !muted ? 0.18 + level * 0.82 : 0;
      hueTarget = active && !muted ? (level - 0.5) * 26 : 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function paintAudio() {
    pulse += (target - pulse) * 0.14;
    hueShift += (hueTarget - hueShift) * 0.08;
    const reactive = state.settings?.soundReactive !== false;
    const holo = state.settings?.holoAccent !== false;
    root.style.setProperty("--pulse", reactive ? pulse.toFixed(3) : "0");
    root.style.setProperty("--hue-shift", holo ? hueShift.toFixed(2) : "0");
    requestAnimationFrame(paintAudio);
  }

  /* ---------------------------------------------------------------- */
  /* Click ripples                                                      */
  /* ---------------------------------------------------------------- */

  function spawnRipple(x, y) {
    if (!rippleHost) rippleHost = $("#rippleHost");
    if (!rippleHost) return;
    const ripple = document.createElement("span");
    ripple.className = "island-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    rippleHost.appendChild(ripple);
    setTimeout(() => ripple.remove(), 900);
  }

  /* ---------------------------------------------------------------- */
  /* Drag trail                                                         */
  /* ---------------------------------------------------------------- */

  let trailCanvas = null;
  let trailCtx = null;
  let trailPoints = [];

  function trailSetup() {
    trailCanvas = $("#islandTrail");
    if (!trailCanvas) return;
    trailCtx = trailCanvas.getContext("2d");
    const resize = () => {
      trailCanvas.width = trailCanvas.clientWidth;
      trailCanvas.height = trailCanvas.clientHeight;
    };
    resize();
    window.addEventListener("resize", resize);
  }

  function trailPush(point) {
    if (!trailCtx || state.settings?.dragTrail === false) return;
    trailPoints.push({ x: point.x, y: point.y, life: 1 });
    if (trailPoints.length > 42) trailPoints.shift();
  }

  function trailDraw() {
    if (trailCtx && trailCanvas) {
      const dpr = window.devicePixelRatio || 1;
      trailCtx.setTransform(1, 0, 0, 1, 0, 0);
      trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
      trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const point of trailPoints) {
        point.life -= 0.022;
        const radius = 16 * (1.1 - point.life * 0.6);
        const glow = trailCtx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
        glow.addColorStop(0, `rgba(190, 140, 255, ${Math.max(0, point.life) * 0.5})`);
        glow.addColorStop(1, "rgba(190, 140, 255, 0)");
        trailCtx.fillStyle = glow;
        trailCtx.beginPath();
        trailCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        trailCtx.fill();
      }
      trailPoints = trailPoints.filter((point) => point.life > 0);
    }
    requestAnimationFrame(trailDraw);
  }

  /* ---------------------------------------------------------------- */
  /* Liquid glass highlight + parallax                                  */
  /* ---------------------------------------------------------------- */

  function bindGlass() {
    const panel = $("#panel");
    if (!panel) return;
    panel.addEventListener("pointermove", (event) => {
      const rect = panel.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      panel.style.setProperty("--glass-x", `${x.toFixed(2)}%`);
      panel.style.setProperty("--glass-y", `${y.toFixed(2)}%`);
      // No tilt: the panel never moves with the mouse, only the highlight
      // follows the pointer.
    });
  }

  /* ---------------------------------------------------------------- */
  /* Theme packs                                                        */
  /* ---------------------------------------------------------------- */

  const PACKS = ["neon", "oled", "amber", "ice"];

  function applyThemePack(pack) {
    for (const name of PACKS) document.body.classList.toggle(`theme-${name}`, name === pack);
  }

  /* ---------------------------------------------------------------- */
  /* Capsule faces                                                      */
  /* ---------------------------------------------------------------- */

  const FACES = ["clock", "pomodoro", "uptime"];

  function applyCapsuleFace(face) {
    for (const node of $$("[data-face]")) {
      node.classList.toggle("is-active", node.dataset.face === face);
    }
  }

  function updateFaces() {
    const face = state.settings?.capsuleFace || "clock";
    const timer = state.timer;
    const timerEl = $("#idleFaceTimer");
    if (timerEl) {
      timerEl.textContent = timer ? DI.fmtClock(timer.remaining) : "25:00";
    }
    const uptimeEl = $("#idleFaceUptime");
    if (uptimeEl) {
      const seconds = Number(state.bridge.system?.uptime) || 0;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      uptimeEl.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Count-up numbers                                                   */
  /* ---------------------------------------------------------------- */

  const counters = new Map();

  function countUp(node, value, suffix = "") {
    if (!node) return;
    const key = `${node.id}:${value}`;
    if (counters.get(node) === key) return;
    counters.set(node, key);
    const from = Number(node.dataset.value || 0);
    const to = Number(value) || 0;
    node.dataset.value = String(to);
    if (from === to) {
      node.textContent = `${to}${suffix}`;
      return;
    }
    const start = performance.now();
    const duration = 420;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = `${Math.round(from + (to - from) * eased)}${suffix}`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  DI.countUp = countUp;

  /* ---------------------------------------------------------------- */
  /* Boot                                                               */
  /* ---------------------------------------------------------------- */

  function initVisuals() {
    trailSetup();
    watchAudio();
    paintAudio();
    trailDraw();
    bindGlass();

    document.addEventListener(
      "pointerdown",
      (event) => {
        const compact = $("#compact");
        if (compact?.contains(event.target)) spawnRipple(event.clientX, event.clientY);
      },
      true
    );

    document.addEventListener("mousemove", (event) => {
      if (document.body.classList.contains("is-dragging-island")) {
        trailPush({ x: event.clientX, y: event.clientY });
      }
    });

    const original = DI.applySettings;
    DI.applySettings = (settings) => {
      original?.(settings);
      applyThemePack(settings?.themePack || "neon");
      applyCapsuleFace(settings?.capsuleFace || "clock");
      updateFaces();
    };

    setInterval(updateFaces, 1000);
    updateFaces();
  }

  DI.initVisuals = initVisuals;
  DI.inits.push(initVisuals);
})();
