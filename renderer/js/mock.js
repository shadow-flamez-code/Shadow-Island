"use strict";

/* Preview/mock data source. Mirrors the preload API so the exact same UI
   runs inside Electron or a plain browser at ?preview=now|system|tools|live. */
(() => {
  const DI = window.DI;

  function mulberry32(seed) {
    return function rand() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeArt(seed, palette) {
    const size = 480;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const rand = mulberry32(seed);

    const base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, palette[0]);
    base.addColorStop(0.55, palette[1]);
    base.addColorStop(1, palette[2]);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    const glowA = ctx.createRadialGradient(size * 0.22, size * 0.18, 10, size * 0.22, size * 0.18, size * 0.75);
    glowA.addColorStop(0, palette[3]);
    glowA.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, size, size);

    const glowB = ctx.createRadialGradient(size * 0.85, size * 0.82, 10, size * 0.85, size * 0.82, size * 0.65);
    glowB.addColorStop(0, palette[4]);
    glowB.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glowB;
    ctx.fillRect(0, 0, size, size);

    // Diagonal speed lines.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-0.62);
    for (let i = 0; i < 26; i += 1) {
      const y = -size + rand() * size * 2;
      ctx.fillStyle = `rgba(255,255,255,${0.015 + rand() * 0.05})`;
      ctx.fillRect(-size, y, size * 2, 0.8 + rand() * 2.6);
    }
    ctx.restore();

    // Concentric neon rings.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, size * (0.17 + i * 0.075), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.2 - i * 0.04})`;
      ctx.lineWidth = i === 0 ? 2.2 : 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.055, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.shadowColor = palette[3];
    ctx.shadowBlur = 30;
    ctx.fill();
    ctx.restore();

    // Horizon slash.
    ctx.beginPath();
    ctx.moveTo(0, size * 0.72);
    ctx.lineTo(size, size * 0.44);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Grain.
    for (let i = 0; i < 900; i += 1) {
      ctx.fillStyle = `rgba(255,255,255,${rand() * 0.08})`;
      ctx.fillRect(rand() * size, rand() * size, 1, 1);
    }

    const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.72);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    return canvas.toDataURL("image/png");
  }

  const TRACKS = [
    {
      title: "Neon Skyline",
      artist: "Aurora Wave",
      album: "Night Drive",
      duration: 254,
      app: "Spotify",
      palette: ["#170a2e", "#2a0f44", "#070711", "rgba(216,80,255,0.85)", "rgba(34,211,238,0.65)"],
    },
    {
      title: "Midnight Circuit",
      artist: "KIRA//VOID",
      album: "Afterglow",
      duration: 221,
      app: "Spotify",
      palette: ["#04121a", "#0b2a38", "#05060b", "rgba(34,211,238,0.8)", "rgba(168,85,247,0.6)"],
    },
    {
      title: "Velvet Static",
      artist: "NOVA SUMMER",
      album: "Soft Errors",
      duration: 198,
      app: "Spotify",
      palette: ["#1d0714", "#3a0c24", "#08060c", "rgba(244,114,182,0.85)", "rgba(251,191,36,0.5)"],
    },
  ];

  const LYRICS = [
    [5, "City lights are bleeding through the rain"],
    [14, "I trace the skyline on the window pane"],
    [23, "Every signal fading into blue"],
    [32, "The night keeps moving and I move too"],
    [43, "Hold the frequency, don't let it go"],
    [52, "Neon rivers where the dreamers flow"],
    [61, "We were never meant to slow down"],
    [71, "Chasing static through the heart of town"],
    [82, "If the morning finds us out of phase"],
    [93, "We'll burn the map and lose the days"],
    [104, "Hold the frequency, don't let it go"],
    [116, "Neon rivers where the dreamers flow"],
    [128, "No destination, just the light"],
    [140, "A thousand colors in the dead of night"],
    [154, "Run the wire, let the current rise"],
    [168, "See the city through electric eyes"],
    [184, "If the silence comes, we'll make our own"],
    [200, "A little louder than the thunderstorm"],
    [218, "Hold the frequency, don't let it go"],
    [232, "Neon rivers where the dreamers flow"],
    [246, "…"],
  ];

  DI.createMockApi = () => {
    const listeners = new Map();
    const event = (name) => (callback) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return () => listeners.get(name)?.delete(callback);
    };
    const emit = (name, payload) => {
      for (const callback of listeners.get(name) || []) {
        try {
          callback(payload);
        } catch (error) {
          console.error(error);
        }
      }
    };

    const arts = TRACKS.map((track, index) => makeArt(97 + index * 41, track.palette));
    let trackIndex = 0;
    let playing = true;
    let basePosition = 74;
    let anchoredAt = performance.now();
    let volume = 0.68;
    let muted = false;
    let focus = false;
    let simTimer = null;
    let notesText = "Demo notes pad.\n- album art accent is synced\n- focus mode on friday";
    let started = false;

    const mockAppearance = {
      accentMode: "wallpaper",
      accentPrimary: "#A855F7",
      accentSecondary: "#22D3EE",
      progressRing: true,
      autoLightDark: true,
      launchAtLogin: false,
    };

    const audio = {
      output: "Speakers · Realtek High Definition Audio",
      outputId: "realtek",
      outputs: [
        { id: "realtek", name: "Speakers · Realtek High Definition Audio" },
        { id: "sony", name: "Headphones · WH-1000XM5" },
        { id: "rockerz", name: "Bluetooth · Rockerz 460" },
      ],
      microphone: {
        name: "Microphone Array · Realtek",
        muted: false,
        available: true,
      },
    };

    const stats = {
      cpu: 34,
      cores: 8,
      coresUsage: [22, 41, 18, 55, 33, 26, 48, 39],
      memory: 61,
      memoryUsed: 10180 * 1024 * 1024,
      memoryTotal: 16688 * 1024 * 1024,
      uptime: 3 * 3600 + 42 * 60,
      gpu: {
        name: "NVIDIA GeForce RTX 4060 Laptop GPU",
        usage: 48,
        temperature: 62,
        memoryUsed: 4120 * 1024 * 1024,
        memoryTotal: 8188 * 1024 * 1024,
        vendor: "NVIDIA",
        available: true,
      },
      network: {
        up: 238 * 1024,
        down: 1.84 * 1024 * 1024,
        ssid: "NIGHTDRIVE-5G",
        type: "Wi-Fi",
      },
      battery: { available: true, percent: 78, plugged: false, secondsLeft: 3 * 3600 + 12 * 60 },
      powerMode: "Balanced",
      biometrics: { available: true, service: "WbioSrvc", status: "running" },
      privacy: {
        webcam: { active: false, app: "", count: 0 },
        microphone: { active: true, app: "Chrome", count: 1 },
        location: { active: false, app: "", count: 0 },
      },
      bluetooth: {
        available: true,
        powered: true,
        devices: [
          { name: "Rockerz 460", instanceId: "bt_rockerz", paired: true, audio: true },
          { name: "Surface Pen", instanceId: "bt_pen", paired: true, audio: false },
          { name: "Headphones · WH-1000XM5", instanceId: "bt_sony", paired: true, audio: true },
        ],
        services: { bthserv: "running" },
      },
      wifiDetail: { ssid: "NIGHTDRIVE-5G", signal: 86, rate: 866.7, channel: 44, auth: "WPA2" },
      wallpaperAccent: { primary: "#F472B6", secondary: "#FB923C" },
      brightness: { supported: true, level: 72 },
      topProcesses: [
        { name: "chrome.exe", cpu: 9.4 },
        { name: "Spotify.exe", cpu: 4.1 },
        { name: "electron.exe", cpu: 2.8 },
      ],
      processCount: 247,
    };

    const files = [
      { path: "C:\\Users\\demo\\Downloads\\neon_alley_final.mp4", name: "neon_alley_final.mp4", dir: "Downloads", size: 189.4 * 1024 * 1024, isDir: false, ext: "mp4", at: Date.now() - 240000 },
      { path: "C:\\Users\\demo\\Downloads\\wallpaper_pack.zip", name: "wallpaper_pack.zip", dir: "Downloads", size: 96.2 * 1024 * 1024, isDir: false, ext: "zip", at: Date.now() - 900000 },
      { path: "C:\\Users\\demo\\Documents\\setlist.pdf", name: "setlist.pdf", dir: "Documents", size: 2.4 * 1024 * 1024, isDir: false, ext: "pdf", at: Date.now() - 1800000 },
      { path: "C:\\Users\\demo\\Pictures\\album_cover.png", name: "album_cover.png", dir: "Pictures", size: 8.1 * 1024 * 1024, isDir: false, ext: "png", at: Date.now() - 3600000 },
    ];

    let clipboard = [
      { id: "clip_link", type: "link", text: "https://github.com/electron/electron/releases/latest", at: Date.now() - 90000, pinned: true },
      { id: "clip_note", type: "text", text: "Rear light strip measured at 42 mm. Update the CAD before the print window closes.", at: Date.now() - 7 * 60000, pinned: false },
      { id: "clip_image", type: "image", text: "album_cover.png", dataUrl: arts[0], at: Date.now() - 19 * 60000, pinned: false },
      { id: "clip_cmd", type: "text", text: "npm run dist -- --win portable", at: Date.now() - 41 * 60000, pinned: false },
      { id: "clip_color", type: "text", text: "#A855F7 → #22D3EE", at: Date.now() - 58 * 60000, pinned: false },
    ];

    const launcher = [
      { id: "explorer", name: "Explorer", icon: "folder", builtin: true },
      { id: "terminal", name: "Terminal", icon: "terminal", builtin: true },
      { id: "settings", name: "Settings", icon: "gear", builtin: true },
      { id: "calculator", name: "Calculator", icon: "calculator", builtin: true },
      { id: "notepad", name: "Notepad", icon: "note", builtin: true },
      { id: "taskmgr", name: "Task Manager", icon: "pulse", builtin: true },
      { id: "camera", name: "Camera", icon: "camera", builtin: true },
      { id: "browser", name: "Browser", icon: "globe", builtin: true },
      { id: "custom_spotify", name: "Spotify", icon: "music", builtin: false },
      { id: "custom_code", name: "VS Code", icon: "code", builtin: false },
      { id: "custom_discord", name: "Discord", icon: "gamepad", builtin: false },
    ];

    const previewParams = new URLSearchParams(window.location.search);
    const hideActivities = previewParams.get("noActivities") === "1";
    let activities = DI.mockIdle || hideActivities ? [] : [
      {
        id: "demo-transfer",
        title: "Transferring · Steam update",
        subtitle: "18.4 GB of 28.7 GB · Steam",
        progress: 64,
        status: "active",
        icon: "download",
        accent: "#22d3ee",
        eta: "8 min left",
        steps: ["Downloading", "Verifying", "Installing"],
        updatedAt: Date.now(),
      },
      {
        id: "demo-render",
        title: "Rendering · Neon Alley.mp4",
        subtitle: "Clip 04 · 4K ProRes · 38%",
        progress: 38,
        status: "active",
        icon: "render",
        accent: "#f472b6",
        eta: "4 min",
        steps: ["Analyzing", "Rendering", "Encoding"],
        updatedAt: Date.now() - 40000,
      },
      {
        id: "demo-route",
        title: "Route · Home",
        subtitle: "12 min · 6.4 km · via Riverside Ave",
        progress: 72,
        status: "active",
        icon: "nav",
        accent: "#4ade80",
        eta: "12 min",
        steps: ["Melbourne St", "Riverside Ave", "Home"],
        updatedAt: Date.now() - 80000,
      },
    ];

    const track = () => TRACKS[trackIndex];
    const positionNow = () => {
      const elapsed = playing ? (performance.now() - anchoredAt) / 1000 : 0;
      return Math.min(track().duration, basePosition + elapsed);
    };
    const mediaState = () => {
      if (DI.mockIdle) return null;
      return {
        active: true,
        trackKey: `demo|${track().title}`,
        app: track().app,
        appId: "Spotify.exe",
        title: track().title,
        artist: track().artist,
        album: track().album,
        playing,
        status: playing ? "playing" : "paused",
        position: positionNow(),
        duration: track().duration,
        canPlay: true,
        canPause: true,
        canToggle: true,
        canPrevious: true,
        canNext: true,
        canSeek: true,
        artwork: arts[trackIndex],
      };
    };
    const bridgeState = () => ({
      media: mediaState(),
      volume: { level: volume, muted, available: true },
      audio: JSON.parse(JSON.stringify(audio)),
      system: JSON.parse(JSON.stringify(stats)),
      status: { media: true, volume: true, system: true, errors: { media: null, volume: null, system: null } },
    });

    const setPlaying = (value) => {
      basePosition = positionNow();
      anchoredAt = performance.now();
      playing = Boolean(value);
    };

    const shiftTrack = (delta) => {
      trackIndex = (trackIndex + delta + TRACKS.length) % TRACKS.length;
      basePosition = 0;
      anchoredAt = performance.now();
    };

    const emitBridge = () => emit("bridge-state", bridgeState());
    const emitStats = () => emit("stats", JSON.parse(JSON.stringify(stats)));

    const randomWalk = (value, amount, min, max, decimals = 1) =>
      Number(DI.clamp(value + (Math.random() - 0.5) * amount, min, max).toFixed(decimals));

    const tick = () => {
      stats.cpu = randomWalk(stats.cpu, 9, 8, 78);
      stats.memory = randomWalk(stats.memory, 1.4, 48, 74);
      stats.memoryUsed = Math.round((stats.memory / 100) * stats.memoryTotal);
      stats.gpu.usage = randomWalk(stats.gpu.usage, 14, 12, 88);
      stats.gpu.temperature = Math.round(randomWalk(stats.gpu.temperature, 3, 54, 74));
      stats.network.up = Math.round(randomWalk(stats.network.up / 1024, 160, 20, 720));
      stats.network.down = Math.round(randomWalk(stats.network.down / 1024, 900, 180, 4200));
      stats.network.up *= 1024;
      stats.network.down *= 1024;
      stats.uptime += 3;
      emitStats();
      emitBridge();
    };

    const api = {
      isMock: true,
      setInteractive() {},
      setPanelState() {},
      rendererReady() {
        if (started) return;
        started = true;
        emit("app-info", { version: "1.0.0", packaged: false, focusMode: focus });
        emit("clipboard", clipboard.map((item) => ({ ...item })));
        emit("launcher-list", launcher.map((item) => ({ ...item })));
        emit("activities", activities.map((item) => ({ ...item })));
        emitBridge();
        setTimeout(emitStats, 220);
        simTimer = setInterval(tick, 1500);
        simTimer.unref?.();
      },
      requestClose() {},
      mediaCommand(action) {
        if (action === "toggle") setPlaying(!playing);
        if (action === "play") setPlaying(true);
        if (action === "pause") setPlaying(false);
        if (action === "next") shiftTrack(1);
        if (action === "previous") shiftTrack(-1);
        if (action === "refresh") {}
        emit("bridge-state", bridgeState());
      },
      seek(seconds) {
        basePosition = DI.clamp(Number(seconds) || 0, 0, track().duration);
        anchoredAt = performance.now();
        emitBridge();
      },
      setVolume(level) {
        volume = DI.clamp(Number(level) || 0, 0, 1);
        if (volume > 0 && muted) muted = false;
        emitBridge();
      },
      setMuted(value) {
        muted = Boolean(value);
        emitBridge();
      },
      setMicMuted(value) {
        audio.microphone.muted = Boolean(value);
        emitBridge();
      },
      toggleMic() {
        audio.microphone.muted = !audio.microphone.muted;
        emitBridge();
      },
      setOutputDevice(deviceId) {
        const device = audio.outputs.find((item) => item.id === deviceId);
        if (!device) return;
        audio.output = device.name;
        audio.outputId = device.id;
        emitBridge();
      },
      setBrightness() {},
      getNotes() {
        return Promise.resolve(notesText);
      },
      saveNotes(value) {
        notesText = String(value || "");
        return Promise.resolve(true);
      },
      getSettings() {
        return Promise.resolve({ ...mockAppearance });
      },
      saveSettings(patch) {
        if (patch && typeof patch === "object") Object.assign(mockAppearance, patch);
        return Promise.resolve({ ...mockAppearance });
      },
      setFocus(value) {
        focus = Boolean(value);
        emit("focus-state", focus);
        emit("notification", {
          app: "Focus",
          title: focus ? "Focus mode on" : "Focus mode off",
          body: focus ? "Notification popups are paused." : "Popups are allowed again.",
          duration: 3200,
          tone: "focus",
        });
      },
      copyClipboard(id) {
        const entry = clipboard.find((item) => item.id === id);
        if (!entry) return;
        clipboard = [entry, ...clipboard.filter((item) => item !== entry)];
        emit("clipboard", clipboard.map((item) => ({ ...item })));
      },
      writeClipboard(text) {
        clipboard.unshift({ id: `clip_${Date.now()}`, type: "text", text: String(text || ""), at: Date.now(), pinned: false });
        emit("clipboard", clipboard.map((item) => ({ ...item })));
      },
      pinClipboard(id) {
        const entry = clipboard.find((item) => item.id === id);
        if (entry) entry.pinned = !entry.pinned;
        emit("clipboard", clipboard.map((item) => ({ ...item })));
      },
      deleteClipboard(id) {
        clipboard = clipboard.filter((item) => item.id !== id);
        emit("clipboard", clipboard.map((item) => ({ ...item })));
      },
      clearClipboard() {
        clipboard = clipboard.filter((item) => item.pinned);
        emit("clipboard", clipboard.map((item) => ({ ...item })));
      },
      launchApp(id) {
        const app = launcher.find((item) => item.id === id);
        if (app) DI.toast(`Launching ${app.name}`);
      },
      removeLauncherApp(id) {
        launcher.splice(0, launcher.length, ...launcher.filter((item) => item.id !== id));
        emit("launcher-list", launcher.map((item) => ({ ...item })));
      },
      openPath(path) {
        DI.toast(`Opening ${String(path).split(/[\\/]/).pop()}`);
      },
      revealPath(path) {
        DI.toast(`Revealing ${String(path).split(/[\\/]/).pop()}`);
      },
      openBluetooth() {
        DI.toast("Opening Bluetooth settings");
      },
      openNetwork() {
        DI.toast("Opening Network settings");
      },
      hideIsland() {},
      quitApp() {},
      removeActivity(id) {
        activities = activities.filter((item) => item.id !== id);
        emit("activities", activities.map((item) => ({ ...item })));
      },
      async getClipboard() {
        return clipboard.map((item) => ({ ...item }));
      },
      async getLauncher() {
        return launcher.map((item) => ({ ...item }));
      },
      async addLauncherApp() {
        launcher.push({ id: `custom_${Date.now()}`, name: "Pinned app", icon: "app", builtin: false });
        emit("launcher-list", launcher.map((item) => ({ ...item })));
        return launcher[launcher.length - 1];
      },
      async addLauncherUrl(payload) {
        const url = String(payload?.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return null;
        const name = String(payload?.name || url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]).slice(0, 40);
        const entry = { id: `web_${Date.now()}`, name, icon: "globe", builtin: false };
        launcher.push(entry);
        emit("launcher-list", launcher.map((item) => ({ ...item })));
        return entry;
      },
      async getLyrics() {
        return {
          synced: LYRICS.map(([time, text]) => ({ time, text })),
          plain: LYRICS.map(([, text]) => text).join("\n"),
          matched: { title: track().title, artist: track().artist, album: track().album, duration: track().duration },
          source: "LRCLIB",
        };
      },
      async getActivities() {
        return activities.map((item) => ({ ...item }));
      },
      async addActivity(payload) {
        const existing = activities.find((item) => item.id === payload?.id);
        const entry = {
          id: payload?.id || `demo_${Date.now()}`,
          title: String(payload?.title || "Background task"),
          subtitle: String(payload?.subtitle || ""),
          progress: payload?.progress ?? null,
          status: payload?.status || (payload?.progress >= 100 ? "done" : "active"),
          icon: payload?.icon || "generic",
          accent: payload?.accent || "#8b5cf6",
          eta: payload?.eta || "",
          steps: Array.isArray(payload?.steps) ? payload.steps : [],
          updatedAt: Date.now(),
        };
        activities = existing
          ? activities.map((item) => (item.id === entry.id ? { ...item, ...entry } : item))
          : [entry, ...activities];
        emit("activities", activities.map((item) => ({ ...item })));
        return entry;
      },
      onBridgeState: event("bridge-state"),
      onStats: event("stats"),
      onNotification: event("notification"),
      onCollapse: event("collapse"),
      onTogglePanel: event("toggle-panel"),
      onAppInfo: event("app-info"),
      onRefreshLayout: event("refresh-layout"),
      onOpenTab: event("open-tab"),
      onFocusState: event("focus-state"),
      onClipboard: event("clipboard"),
      onLauncher: event("launcher-list"),
      onActivities: event("activities"),
      onFilesDropped: event("files-dropped"),
    };

    api.__files = files;
    return api;
  };
})();
