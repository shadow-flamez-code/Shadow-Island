"use strict";

/* Shared namespace + tiny helpers used by every renderer module. */
window.DI = {
  inits: [],
  redrawHooks: [],
  isPreview: false,
  previewTab: "now",
  api: null,
  state: null,
};

(() => {
  const DI = window.DI;

  DI.$ = (selector, root = document) => root.querySelector(selector);
  DI.$$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  DI.clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  DI.escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);

  DI.icon = (name, extra = "") =>
    `<svg class="ico${extra ? ` ${extra}` : ""}"><use href="#i-${name}"></use></svg>`;

  DI.setIcon = (target, name) => {
    if (!target) return;
    const use =
      target.tagName && target.tagName.toLowerCase() === "svg"
        ? target.querySelector("use")
        : target;
    if (use && use.getAttribute("href") !== `#i-${name}`) {
      use.setAttribute("href", `#i-${name}`);
    }
  };

  DI.fmtTime = (seconds, forceHours = false) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0 || forceHours) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  DI.fmtClock = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  DI.fmtUptime = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h`;
    return `${Math.max(1, Math.round(total / 60))}m`;
  };

  DI.fmtBytes = (bytes) => {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value;
    let unit = -1;
    do {
      size /= 1024;
      unit += 1;
    } while (size >= 1024 && unit < units.length - 1);
    return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
  };

  DI.fmtRate = (bytesPerSecond) => {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    if (value < 1024) return `${Math.round(value)} B/s`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB/s`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  DI.rateParts = (bytesPerSecond) => {
    const value = Math.max(0, Number(bytesPerSecond) || 0);
    if (value < 1024 * 1024) {
      return { value: String(Math.round(value / 1024)), unit: "KB/s" };
    }
    return { value: (value / (1024 * 1024)).toFixed(1), unit: "MB/s" };
  };

  DI.relTime = (timestamp) => {
    const diff = Date.now() - Number(timestamp || 0);
    if (!Number.isFinite(diff) || diff < 0) return "now";
    if (diff < 60 * 1000) return "just now";
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  DI.shortName = (value, max = 26) => {
    const text = String(value ?? "").trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  };

  DI.setRangeFill = (input) => {
    if (!input) return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value) || 0;
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--fill", `${DI.clamp(pct, 0, 100)}%`);
  };

  DI.dprCanvas = (canvas) => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: rect.width, height: rect.height };
  };

  DI.colors = {
    purple: "#a855f7",
    violet: "#7c3aed",
    cyan: "#22d3ee",
    pink: "#f472b6",
    green: "#4ade80",
    amber: "#fbbf24",
    red: "#fb7185",
    dim: "#726e8e",
  };

  DI.drawSpark = (canvas, values, color = DI.colors.purple, options = {}) => {    const baked = DI.dprCanvas(canvas);
    if (!baked) return;
    const { ctx, width, height } = baked;
    ctx.clearRect(0, 0, width, height);
    if (!values || values.length < 2) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height - 2);
      ctx.lineTo(width, height - 2);
      ctx.stroke();
      return;
    }
    const max = Math.max(options.max || 0, ...values, 1);
    const min = Math.min(options.min ?? 0, ...values);
    const span = Math.max(0.0001, max - min);
    const pad = 2;
    const points = values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return [x, y];
    });
    const trace = () => {
      ctx.beginPath();
      points.forEach(([x, y], index) => {
        if (index === 0) {
          ctx.moveTo(x, y);
          return;
        }
        const [px, py] = points[index - 1];
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        if (index === points.length - 1) ctx.lineTo(x, y);
      });
    };
    if (options.fill !== false) {
      trace();
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${color}44`);
      gradient.addColorStop(1, `${color}00`);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  DI.toast = (message) => {
    const peek = DI.$("#peek");
    if (!peek) return;
    DI.notify({ app: "Shadow Island", title: message, body: "", duration: 1800 });
  };

  // Soft two-note chime (WebAudio) for timer/Security events.
  DI.chime = () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      DI._audioCtx ||= new AC();
      const ctx = DI._audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      [659.25, 987.77].forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = ctx.currentTime + index * 0.16;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.6);
      });
    } catch {}
  };
})();
