"use strict";

/* Ambient particle field behind the panel — soft drifting orbs that
   tint from the island accent. Paused when the panel is closed. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const state = DI.state;

  const PARTICLES = 42;
  let canvas = null;
  let ctx = null;
  let particles = [];
  let raf = 0;
  let accent = { a: { r: 168, g: 85, b: 247 }, b: { r: 34, g: 211, b: 238 } };

  function parse(hex, fallback) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!match) return fallback;
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
  }

  function refreshAccent() {
    const root = getComputedStyle(document.documentElement);
    const primary = (document.documentElement.style.getPropertyValue("--accent") || root.getPropertyValue("--accent") || "").trim();
    const secondary = (document.documentElement.style.getPropertyValue("--accent-2") || root.getPropertyValue("--accent-2") || "").trim();
    if (primary.startsWith("#")) accent.a = parse(primary, accent.a);
    if (secondary.startsWith("#")) accent.b = parse(secondary, accent.b);
    else if (primary.startsWith("#")) accent.b = parse(primary, accent.b);
  }

  function seed(width, height) {
    particles = Array.from({ length: PARTICLES }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.8 + Math.random() * 2.2,
      vy: -(0.05 + Math.random() * 0.16),
      vx: (Math.random() - 0.5) * 0.08,
      drift: Math.random() * Math.PI * 2,
      driftSpeed: 0.002 + Math.random() * 0.006,
      hue: Math.random() < 0.5 ? "a" : "b",
      twinkle: 0.4 + Math.random() * 0.6,
      twinkleSpeed: 0.01 + Math.random() * 0.03,
    }));
  }

  function frame() {
    raf = 0;
    if (!ctx || !canvas) return;
    if (!state.panelOpen) return; // keep particles frozen while collapsed
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.drift += p.driftSpeed;
      p.x += p.vx + Math.sin(p.drift) * 0.12;
      p.y += p.vy + Math.cos(p.drift) * 0.04;
      p.twinkle += p.twinkleSpeed;
      if (p.y < -6) { p.y = height + 6; p.x = Math.random() * width; }
      if (p.x < -6) p.x = width + 6;
      if (p.x > width + 6) p.x = -6;
      const color = accent[p.hue];
      const alpha = 0.14 + Math.sin(p.twinkle) * 0.1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${Math.max(0.05, alpha)})`;
      ctx.shadowColor = `rgba(${color.r},${color.g},${color.b},0.6)`;
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    raf = requestAnimationFrame(frame);
  }

  function ensureLoop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function initAmbient() {
    canvas = $("#ambientFx");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    seed(700, 552);
    refreshAccent();
    ensureLoop();
    window.addEventListener("resize", () => seed(canvas.clientWidth, canvas.clientHeight));
    // Re-tint when the album accent changes.
    const observer = new MutationObserver(() => refreshAccent());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    // Keep the loop alive across panel opens.
    const keeper = setInterval(ensureLoop, 1200);
    keeper.unref?.();
    window.addEventListener("beforeunload", () => clearInterval(keeper));
  }

  DI.inits.push(initAmbient);
})();
