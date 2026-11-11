"use strict";

/* Core shell: state, layout, tabs, click-through, clock, notifications. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;

  const state = (DI.state = {
    panelOpen: false,
    tab: "now",
    split: false,
    focus: false,
    appInfo: { version: "1.0.0", packaged: false },
    settings: {
      accentMode: "wallpaper",
      accentPrimary: "#A855F7",
      accentSecondary: "#22D3EE",
      progressRing: true,
      hoverExpand: true,
      aurora: true,
      odometer: true,
      autoHideFullscreen: false,
      soundReactive: true,
      glassPanel: false,
      holoAccent: true,
      dragTrail: true,
      themePack: "neon",
      capsuleFace: "clock",
      autoLightDark: true,
      launchAtLogin: false,
      dockEdge: "top",
      dockOffset: 0,
    },
    bridge: {
      media: null,
      volume: { level: 0, muted: false, available: false },
      audio: {
        output: "",
        outputId: "",
        outputs: [],
        microphone: { name: "Microphone", muted: false, available: false },
      },
      system: null,
      status: { media: false, volume: false, system: false, errors: {} },
    },
    mediaAnchor: { position: 0, at: performance.now(), playing: false, trackKey: "", duration: 0, rate: 1 },
    mediaSettleUntil: 0,
    lyrics: { synced: [], plain: "", matched: null, source: "", trackKey: "", status: "idle" },
    activeLyric: -1,
    draggingSeek: false,
    draggingVolume: false,
    volumeGuardUntil: 0,
    clipboard: [],
    launcher: [],
    activities: [],
    files: [],
    history: { cpu: [], ram: [], gpu: [], netUp: [], netDown: [], battery: [] },
    batteryAlerted: false,
    hello: { scanning: false, verified: false },
    privacySeen: false,
    privacyLast: {},
    online: { media: false, volume: false, system: false },
  });

  const TABS = ["now", "system", "tools", "live", "link", "settings"];
  const TONE_ICONS = {
    power: "bolt",
    privacy: "shield",
    focus: "moon",
    success: "check",
    media: "music",
    error: "shield",
  };

  let lastInteractive = null;
  let suppressClickUntil = 0;

  /* Blocks the click that ends a Ctrl+Shift drag from also opening the
     dashboard. The block expires on its own so the next real click works. */
  DI.suppressIslandClick = (ms = 0) => {
    suppressClickUntil = performance.now() + Math.max(0, Number(ms) || 0);
  };
  let notificationQueue = [];
  let notificationActive = false;
  let notificationTimer = null;
  let notificationFrame = 0;
  let lastVolume = null;
  let lastMuted = null;
  let lastMicMuted = null;
  const bootedAt = Date.now();
  const hudReady = () => Date.now() - bootedAt > 3000;
  let volumeHudTimer = null;
  let micHudTimer = null;

  /* ---------------------------------------------------------------- */
  /* Layout / tabs                                                     */
  /* ---------------------------------------------------------------- */

  DI.setTab = (tab, redraw = true) => {
    if (!TABS.includes(tab)) tab = "now";
    state.tab = tab;
    $$(".tab").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".page").forEach((page) => page.classList.toggle("is-active", page.dataset.page === tab));
    DI.placeTabSlider();
    if (redraw) requestAnimationFrame(() => DI.redrawPanels?.());
  };

  DI.placeTabSlider = () => {
    const slider = $("#tabSlider");
    const activeTab = $(".tab.is-active");
    if (slider && activeTab) {
      slider.style.width = `${activeTab.offsetWidth}px`;
      slider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
    }
  };

  DI.syncLayout = () => {    document.body.classList.toggle("panel-open", state.panelOpen);
    document.body.classList.toggle("split-mode", state.split);
    const split = $("#split");
    if (split) split.hidden = !(state.split && !state.panelOpen);
    const compact = $("#compact");
    if (compact) compact.hidden = Boolean(state.split && !state.panelOpen);
    const splitTimer = $("#splitTimer");
    if (splitTimer) {
      const timer = state.timer;
      const timerActive = timer && (timer.mode === "pomodoro"
        ? timer.running || timer.remaining < timer.total - 0.5
        : timer.running || timer.elapsed > 0);
      splitTimer.hidden = !timerActive;
    }
    const splitButton = $("#splitToggle");
    if (splitButton) {
      splitButton.classList.toggle("is-on", state.split);
      splitButton.setAttribute("aria-pressed", state.split ? "true" : "false");
    }
    if (state.panelOpen) {
      if (lastInteractive !== true) {
        lastInteractive = true;
        DI.api?.setInteractive(true);
      }
    }
    DI.reportWindowBox?.();
  };

  /* ---------------------------------------------------------------- */
  /* Window sizing                                                     */
  /* ---------------------------------------------------------------- */

  /* The overlay window is resized to the artwork that is actually on
     screen: the small pill, the medium (hovered) pill, or the dashboard.
     A window bigger than the artwork would eat clicks meant for the
     desktop, because an interactive transparent window swallows everything
     inside its bounds. */
  const PILL_WIDTHS = { idle: 240, media: 256, activity: 256, timer: 256 };
  const MEDIUM_WIDTHS = { idle: 292, media: 324, activity: 324, timer: 324 };
  /* The window carries a little extra room so the pill's outer glow and
     drop shadow can fade out instead of being cut off at the window edge. */
  const EDGE_MARGIN = 48;
  const PILL_WINDOW_HEIGHT = 100;
  const NOTIFY_WINDOW_HEIGHT = 240;
  const NOTIFY_WINDOW_WIDTH = 430;
  let lastWindowBox = { width: 0, height: 0 };
  let shrinkTimer = null;

  /* Window size that frames a capsule of the given size. */
  DI.windowBoxFor = (pillWidth, pillHeight, vertical = false) => ({
    width: Math.round(pillWidth + EDGE_MARGIN),
    height: Math.round(pillHeight + (vertical ? EDGE_MARGIN : EDGE_MARGIN + 10)),
  });

  /* The size the capsule *will* have — used when docking, because the
     current size may still be mid-animation. */
  DI.pillSizeFor = (vertical = false) => {
    if (vertical) return { width: 42, height: 256 };
    const compact = $("#compact");
    const mode = compact?.dataset.mode || "idle";
    const hovering =
      Boolean(compact?.matches(":hover")) || Boolean(compact?.classList.contains("is-hover"));
    const width = hovering ? MEDIUM_WIDTHS[mode] : PILL_WIDTHS[mode];
    return { width: width || 256, height: 42 };
  };

  /* Moves the island to a docked edge. */
  DI.dockIsland = (edge, offset = 0) => {
    const vertical = edge === "left" || edge === "right";
    $("#compact")?.classList.toggle("is-vertical", vertical);
    const size = DI.pillSizeFor(vertical);
    const box = DI.windowBoxFor(size.width, size.height, vertical);
    DI.api?.setDock?.({
      mode: "edge",
      edge,
      offset,
      width: box.width,
      height: box.height,
      animate: true,
    });
  };

  function computeWindowBox() {
    if (state.panelOpen) return null;
    if (state.split) {
      return { width: 226 * 2 + 14 + EDGE_MARGIN, height: PILL_WINDOW_HEIGHT };
    }
    const compact = $("#compact");
    const mode = compact?.dataset.mode || "idle";
    const hovering =
      Boolean(compact?.matches(":hover")) || Boolean(compact?.classList.contains("is-hover"));
    if (document.body.classList.contains("is-mini")) {
      // The edge-swipe mini player is always the same size.
      return { width: 330 + EDGE_MARGIN, height: PILL_WINDOW_HEIGHT };
    }
    let width = hovering
      ? MEDIUM_WIDTHS[mode] || 324
      : PILL_WIDTHS[mode] || 256;
    let height = PILL_WINDOW_HEIGHT;
    const peekVisible = Boolean($("#peek")?.classList.contains("is-visible"));
    const hudVisible = Boolean(document.querySelector(".hud.is-visible"));
    if (peekVisible || hudVisible) {
      // Notifications and HUDs live below the pill: give them their own
      // room so nothing is clipped.
      width = Math.max(width, NOTIFY_WINDOW_WIDTH);
      height = NOTIFY_WINDOW_HEIGHT;
    }
    if (compact?.classList.contains("is-vertical")) {
      // Vertical capsule: the window hugs the rotated island. The size is
      // fixed per orientation, because during the rotation animation the
      // measured box is still halfway between the two orientations.
      const verticalHeight = hovering ? 324 : 256;
      return {
        width: 42 + EDGE_MARGIN,
        height: verticalHeight + EDGE_MARGIN,
      };
    }
    return { width: Math.round(width + EDGE_MARGIN), height };
  }

  function pushWindowBox() {
    const target = computeWindowBox();
    if (!target) return;
    if (
      Math.abs(target.width - lastWindowBox.width) < 2 &&
      Math.abs(target.height - lastWindowBox.height) < 2
    ) {
      return;
    }
    lastWindowBox = target;
    DI.api?.resize?.(target);
  }

  /* `delay` lets the pill finish its collapse animation before the window
     shrinks, so the artwork is never clipped mid-transition. */
  DI.reportWindowBox = (delay = 0) => {
    clearTimeout(shrinkTimer);
    if (delay > 0) {
      shrinkTimer = setTimeout(pushWindowBox, delay);
    } else {
      pushWindowBox();
    }
  };

  DI.openPanel = (tab) => {
    if (tab && TABS.includes(tab)) DI.setTab(tab, false);
    state.panelOpen = true;
    DI.syncLayout();
    DI.api?.setPanelState(true);
    DI.updateClock();
    requestAnimationFrame(() => DI.redrawPanels?.());
  };

  DI.closePanel = (fromMain = false) => {
    if (!state.panelOpen) return;
    state.panelOpen = false;
    DI.syncLayout();
    if (!fromMain) DI.api?.setPanelState(false);
    lastInteractive = false;
    DI.api?.setInteractive(false);
    requestAnimationFrame(() => DI.redrawPanels?.());
  };

  DI.togglePanel = (tab) => {
    if (state.panelOpen) DI.closePanel();
    else DI.openPanel(tab);
  };

  DI.setSplit = (value) => {
    state.split = Boolean(value);
    DI.syncLayout();
    if (state.split && state.panelOpen) {
      setTimeout(() => DI.closePanel(), 180);
    }
  };

  DI.redrawPanels = () => {
    for (const hook of DI.redrawHooks) {
      try {
        hook();
      } catch (error) {
        console.error(error);
      }
    }
  };

  /* ---------------------------------------------------------------- */
  /* Clock                                                             */
  /* ---------------------------------------------------------------- */

  let lastClockSecond = -1;

  DI.updateClock = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const clock = $("#clock");
    if (clock) clock.innerHTML = `${hh}:${mm}<small>${ss}</small>`;
    const railClock = $("#railClock");
    if (railClock) railClock.textContent = `${hh}:${mm}:${ss}`;
    lastClockSecond = now.getSeconds();
  };

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  const clearNotificationProgress = () => {
    if (notificationFrame) cancelAnimationFrame(notificationFrame);
    notificationFrame = 0;
  };

  const finishNotification = () => {
    clearTimeout(notificationTimer);
    clearNotificationProgress();
    const peek = $("#peek");
    peek?.classList.remove("is-visible");
    DI.reportWindowBox?.();
    notificationActive = false;
    setTimeout(() => {
      if (!notificationActive) showNextNotification();
    }, 320);
  };

  function showNextNotification() {
    if (notificationActive) return;
    const payload = notificationQueue.shift();
    if (!payload) return;
    const peek = $("#peek");
    if (!peek) return;

    notificationActive = true;
    peek.classList.remove("tone-power", "tone-privacy", "tone-focus", "tone-success");
    if (payload.tone) peek.classList.add(`tone-${payload.tone}`);

    $("#peekApp").textContent = payload.app || "Shadow Island";
    $("#peekTitle").textContent = payload.title || "Notification";
    const body = $("#peekBody");
    body.textContent = payload.body || "";
    body.style.display = payload.body ? "" : "none";
    DI.setIcon($("#peekIcon"), payload.icon || TONE_ICONS[payload.tone] || "spark");

    const duration = DI.clamp(Number(payload.duration) || 4400, 1400, 16000);
    const progress = $("#peekProgress");
    if (progress) progress.style.transform = "scaleX(1)";

    peek.classList.add("is-visible");
    DI.reportWindowBox?.();
    const startedAt = performance.now();
    const animate = (now) => {
      if (!notificationActive) return;
      const ratio = DI.clamp(1 - (now - startedAt) / duration, 0, 1);
      if (progress) progress.style.transform = `scaleX(${ratio})`;
      if (ratio > 0) notificationFrame = requestAnimationFrame(animate);
    };
    notificationFrame = requestAnimationFrame(animate);
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(finishNotification, duration);
  }

  DI.notify = (payload) => {
    if (!payload) return;
    const tone = payload.tone || "";
    if (state.focus && tone !== "focus") return;
    notificationQueue.push(payload);
    if (notificationQueue.length > 5) notificationQueue.shift();
    if (!notificationActive) showNextNotification();
  };

  DI.clearNotifications = () => {
    notificationQueue = [];
    if (notificationActive) finishNotification();
  };

  /* ---------------------------------------------------------------- */
  /* HUDs                                                              */
  /* ---------------------------------------------------------------- */

  DI.showVolumeHud = () => {
    if (state.panelOpen || !hudReady()) return;
    const hud = $("#volumeHud");
    if (!hud) return;
    const volume = state.bridge.volume;
    const level = Math.round((Number(volume.level) || 0) * 100);
    const muted = Boolean(volume.muted);
    $("#volumeHudName").textContent = state.bridge.audio.output || "System volume";
    $("#volumeHudFill").style.width = `${muted ? 0 : level}%`;
    $("#volumeHudValue").textContent = muted ? "OFF" : String(level);
    DI.setIcon($("#volumeHudIcon"), muted ? "volume-off" : "volume");
    hud.classList.add("is-visible");
    clearTimeout(volumeHudTimer);
    volumeHudTimer = setTimeout(() => {
      hud.classList.remove("is-visible");
      DI.reportWindowBox?.();
    }, 1600);
    DI.reportWindowBox?.();
  };

  DI.showMicHud = () => {
    if (state.panelOpen || !hudReady()) return;
    const hud = $("#micHud");
    if (!hud) return;
    const microphone = state.bridge.audio.microphone;
    const muted = Boolean(microphone.muted);
    hud.classList.toggle("mic-hud-off", muted);
    $("#micHudTitle").textContent = microphone.name || "Microphone";
    $("#micHudName").textContent = muted ? "Muted system-wide" : "Live · capturing allowed";
    $("#micHudState").textContent = muted ? "OFF" : "ON";
    DI.setIcon($("#micHudIcon"), muted ? "mic-off" : "mic");
    hud.classList.add("is-visible");
    clearTimeout(micHudTimer);
    micHudTimer = setTimeout(() => {
      hud.classList.remove("is-visible");
      DI.reportWindowBox?.();
    }, 1600);
    DI.reportWindowBox?.();
  };

  /* ---------------------------------------------------------------- */
  /* Bridge / stats ingestion                                          */
  /* ---------------------------------------------------------------- */

  DI.positionNow = () => {
    const anchor = state.mediaAnchor;
    const media = state.bridge.media;
    if (!media || !anchor.duration) return anchor.position || 0;
    const elapsed = anchor.playing
      ? ((performance.now() - anchor.at) / 1000) * (anchor.rate || 1)
      : 0;
    return DI.clamp(anchor.position + elapsed, 0, anchor.duration);
  };

  DI.anchorMedia = (position, playing, trackKey, duration) => {
    state.mediaAnchor = {
      position: Number(position) || 0,
      at: performance.now(),
      playing: Boolean(playing),
      trackKey: trackKey || "",
      duration: Number(duration) || 0,
      rate: 1,
    };
    // Real apps often keep reporting the pre-seek position for a few polls.
    // Ignore bridge samples briefly so the bar does not snap back.
    state.mediaSettleUntil = performance.now() + 1500;
  };

  function updateRail(status) {
    if (!status) return;
    const online = {
      media: Boolean(status.media),
      volume: Boolean(status.volume),
      system: Boolean(status.system),
    };
    state.online = online;
    for (const [service, isOnline] of Object.entries(online)) {
      const node = document.querySelector(`.rail-svc[data-svc="${service}"]`);
      if (node) node.classList.toggle("is-online", isOnline);
    }
  }

  function applyStats(stats) {
    if (!stats || typeof stats !== "object") return;
    state.bridge.system = stats;
    if (stats.theme) DI.applyTheme(stats.theme);
    if (stats.wallpaperAccent) DI.refreshWallpaperAccent?.();
    DI.renderStats?.(stats);

    const battery = stats.battery;
    if (battery?.available) {
      if (!battery.plugged && battery.percent <= 20 && !state.batteryAlerted) {
        state.batteryAlerted = true;
        DI.notify({
          app: "Power",
          title: `Battery low · ${Math.round(battery.percent)}%`,
          body: battery.secondsLeft
            ? `${DI.fmtTime(battery.secondsLeft)} remaining. Plug in soon.`
            : "Plug in soon to keep the island alive.",
          tone: "power",
          duration: 6000,
        });
      }
      if (battery.percent > 24) state.batteryAlerted = false;
    }
  }

  DI.applyStats = applyStats;

  DI.applyTheme = (theme) => {
    const light = state.settings.autoLightDark !== false && Boolean(theme?.light);
    if (state._light !== light) {
      state._light = light;
      document.body.classList.toggle("light", light);
    }
  };

  const notifyThrottle = new Map();
  const smartNotify = (key, payload, throttleMs = 6000) => {
    const last = notifyThrottle.get(key) || 0;
    if (Date.now() - last < throttleMs) return;
    notifyThrottle.set(key, Date.now());
    DI.notify(payload);
  };

  const setTabBadge = (selector, count) => {
    const badge = $(selector);
    if (!badge) return;
    const value = Math.max(0, Math.floor(Number(count) || 0));
    badge.textContent = String(value);
    badge.hidden = value === 0;
    DI.placeTabSlider?.();
  };

  DI.applySettings = (settings) => {
    if (settings && typeof settings === "object") {
      state.settings = { ...state.settings, ...settings };
      if (settings.dock && typeof settings.dock === "object") {
        state.settings.dockEdge = settings.dock.edge || "top";
        state.settings.dockOffset = Number(settings.dock.offset) || 0;
      }
    }
    const current = state.settings;
    document.body.classList.toggle("no-ring", current.progressRing === false);
    document.body.classList.toggle("no-hover-expand", current.hoverExpand === false);
    document.body.classList.toggle("no-aurora", current.aurora === false);
    document.body.classList.toggle("no-odometer", current.odometer === false);
    document.body.classList.toggle("glass-panel", current.glassPanel === true);
    if (current.autoLightDark === false && state._light) {
      state._light = false;
      document.body.classList.remove("light");
    }
    // Accent precedence re-resolves from the current media/wallpaper state.
    DI.reapplyAccent?.();
    return current;
  };

  DI.applyBridge = (snapshot) => {
    if (!snapshot) return;
    const previous = state.bridge;
    const audio = snapshot.audio
      ? {
          ...previous.audio,
          ...snapshot.audio,
          outputs: Array.isArray(snapshot.audio.outputs) ? snapshot.audio.outputs : previous.audio.outputs,
          microphone: { ...previous.audio.microphone, ...(snapshot.audio.microphone || {}) },
        }
      : previous.audio;
    state.bridge = {
      ...previous,
      ...snapshot,
      volume: { ...previous.volume, ...(snapshot.volume || {}) },
      audio,
      status: { ...previous.status, ...(snapshot.status || {}) },
    };

    const media = state.bridge.media;
    const compact = document.getElementById("compact");
    if (media?.active && media.playing) {
      compact?.classList.add("is-active-glow");
    } else {
      compact?.classList.remove("is-active-glow");
    }
    if (media?.active) {
      const key = media.trackKey || `${media.title}|${media.artist}`;
      const anchor = state.mediaAnchor;
      const playing = Boolean(media.playing);
      const incoming = Math.max(0, Number(media.position) || 0);
      const duration = Math.max(0, Number(media.duration) || 0);
      const settling = performance.now() < (state.mediaSettleUntil || 0);
      if (key !== anchor.trackKey || playing !== anchor.playing) {
        DI.anchorMedia(incoming, playing, key, duration);
      } else if (!settling) {
        const predicted = DI.positionNow();
        const drift = incoming - predicted;
        if (!playing) {
          // Paused: only reconcile close reports. Large disagreements are
          // stale timeline snapshots and snapping would visibly jump the bar.
          if (Math.abs(drift) < 1.5) {
            state.mediaAnchor = { ...anchor, position: incoming, at: performance.now(), duration };
          }
        } else if (drift > 5) {
          // Real forward seek or a stale sample: catch up at 1.35x instead of
          // teleporting the progress bar.
          state.mediaAnchor = {
            ...anchor,
            position: predicted,
            at: performance.now(),
            duration,
            rate: 1.35,
          };
        } else if (drift > 0.6) {
          state.mediaAnchor = {
            ...anchor,
            position: predicted + Math.min(0.3, drift * 0.25),
            at: performance.now(),
            duration,
            rate: 1,
          };
        } else if (drift < -0.6) {
          // While playing, a lower timestamp is almost always a stale SMTC
          // snapshot (Chrome freezes it often). Keep the monotonic clock;
          // real seeks re-anchor through anchorMedia.
          state.mediaAnchor = { ...anchor, rate: 1, duration };
        }
      }
    } else {
      DI.anchorMedia(0, false, "", 0);
    }

    // Diff-guard: only re-render when identity-level fields change. The
    // per-frame position is driven by tickMedia, so 0.7s bridge polls must
    // not repaint the card (that was the visible flicker).
    const mediaSig = media
      ? JSON.stringify([
          media.active, media.trackKey, media.title, media.artist, media.album,
          media.app, media.playing, media.status, media.duration,
          media.canPrevious, media.canNext, media.canSeek,
          media.artwork ? media.artwork.length : 0,
        ])
      : "";
    if (mediaSig !== state._mediaSig) {
      const previousMedia = state.bridge.media;
      const previousTrack =
        previousMedia && state._peekTrackKey && state._peekTrackKey !== (previousMedia.trackKey || "");
      state._mediaSig = mediaSig;
      DI.renderMedia?.(media);
      // New track: quiet peek (icon chip, no banner sound).
      if (previousTrack && media?.active && media.playing) {
        state._peekTrackKey = media.trackKey || "";
        smartNotify("track", {
          app: media.app || "Media",
          title: media.title || "Now playing",
          body: media.artist || "",
          icon: "music",
          tone: "media",
          duration: 3000,
        }, 4000);
      } else if (media?.active) {
        state._peekTrackKey = media.trackKey || "";
      }
    }
    const audioSig = audio
      ? JSON.stringify([
          audio.output, audio.outputId,
          (audio.outputs || []).map((item) => item.id),
          audio.microphone?.name, audio.microphone?.muted, audio.microphone?.available,
        ])
      : "";
    if (audioSig !== state._audioSig) {
      const previousAudio = state.bridge.audio;
      const outputChanged =
        previousAudio && audio && previousAudio.outputId && audio.outputId && previousAudio.outputId !== audio.outputId;
      state._audioSig = audioSig;
      DI.renderAudio?.(audio);
      DI.renderMic?.(audio.microphone);
      if (outputChanged && audio.output) {
        smartNotify("output", {
          app: "Audio",
          title: "Output switched",
          body: DI.shortName(audio.output, 44),
          icon: "output",
          duration: 3200,
        }, 3000);
      }
    }

    if (snapshot.system) applyStats(snapshot.system);
    if (snapshot.system?.theme) DI.applyTheme(snapshot.system.theme);
    updateRail(snapshot.status);

    const volume = state.bridge.volume;
    const muted = Boolean(volume.muted);
    if (lastVolume !== null) {
      const changed = Math.abs((Number(volume.level) || 0) - lastVolume) > 0.02 || muted !== lastMuted;
      if (changed && !state.draggingVolume && Date.now() > state.volumeGuardUntil) {
        DI.showVolumeHud();
      }
    }
    lastVolume = Number(volume.level) || 0;
    lastMuted = muted;

    const micMuted = Boolean(audio.microphone?.muted);
    if (lastMicMuted !== null && micMuted !== lastMicMuted) DI.showMicHud();
    lastMicMuted = micMuted;
  };

  DI.applyFocus = (value) => {
    state.focus = Boolean(value);
    document.body.classList.toggle("focus-on", state.focus);
    const quick = $("#focusQuick");
    if (quick) {
      quick.classList.toggle("is-active", state.focus);
      quick.setAttribute("aria-pressed", state.focus ? "true" : "false");
    }
    DI.renderFocus?.();
    DI.updatePill?.();
  };

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  function setInteractive(hit) {
    if (hit === lastInteractive) return;
    lastInteractive = hit;
    DI.api?.setInteractive(Boolean(hit));
  }

  function bindEvents() {
    document.addEventListener(
      "mousemove",
      (event) => {
        if (state.panelOpen) {
          setInteractive(true);
          return;
        }
        const element = document.elementFromPoint(event.clientX, event.clientY);
        setInteractive(Boolean(element?.closest(".interactive")));
      },
      { passive: true }
    );

    document.addEventListener("mouseleave", () => {
      if (!state.panelOpen) setInteractive(false);
    });

    // Highlight the island while a file drag hovers it.
    document.addEventListener("dragenter", (event) => {
      if (event.dataTransfer?.types?.includes("Files")) {
        document.body.classList.add("dragging-file");
        setInteractive(true);
      }
    });
    document.addEventListener("dragleave", (event) => {
      if (!event.relatedTarget) document.body.classList.remove("dragging-file");
    });
    document.addEventListener("dragend", () => {
      document.body.classList.remove("dragging-file");
    });
    document.addEventListener("drop", () => {
      document.body.classList.remove("dragging-file");
    });

    // Hard zones: entering the pill/panel/peek/split always enables pointer
    // input, even if the hover hit-test ever misses a synthetic overlay.
    for (const selector of ["#compact", "#panel", "#peek", "#split"]) {
      const zone = $(selector);
      if (!zone) continue;
      zone.addEventListener("mouseenter", () => {
        setInteractive(true);
        // Grow the window to the medium pill right away so the widened area
        // is real, clickable artwork.
        if (selector === "#compact") DI.reportWindowBox?.();
      });
      zone.addEventListener("mouseleave", () => {
        if (!state.panelOpen) setInteractive(false);
        // Let the pill finish collapsing before the window shrinks again.
        if (selector === "#compact") DI.reportWindowBox?.(540);
      });
    }

    /* Custom right-click menu (glass + accent). */
    const ctxMenu = $("#ctxMenu");
    const closeCtxMenu = () => {
      if (!ctxMenu) return;
      ctxMenu.classList.remove("is-open");
      ctxMenu.hidden = true;
    };
    const openCtxMenu = (x, y) => {
      if (!ctxMenu) return;
      ctxMenu.hidden = false;
      const rect = ctxMenu.getBoundingClientRect();
      ctxMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 8))}px`;
      ctxMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 8))}px`;
      ctxMenu.classList.add("is-open");
    };
    document.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openCtxMenu(event.clientX, event.clientY);
    });
    ctxMenu?.addEventListener("click", (event) => {
      const item = event.target.closest(".ctx-item");
      if (!item) return;
      const action = item.dataset.act;
      closeCtxMenu();
      if (action === "open") DI.openPanel();
      else if (action === "split") DI.setSplit(true);
      else if (action === "focus") DI.api?.setFocus(!state.focus);
      else if (action === "mic") DI.api?.toggleMic();
      else if (action === "hide") DI.api?.hideIsland();
      else if (action === "quit") DI.api?.quitApp();
    });
    document.addEventListener("click", (event) => {
      if (ctxMenu && !ctxMenu.contains(event.target)) closeCtxMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ctxMenu && !ctxMenu.hidden) {
        event.stopPropagation();
        event.preventDefault();
        closeCtxMenu();
      }
    });
    DI.closeCtxMenu = closeCtxMenu;

    document.addEventListener("click", (event) => {
      const target = event.target.closest("button, [data-action]");
      if (!target) return;
      if (target.closest("#compactPrev")) {
        event.stopPropagation();
        DI.api?.mediaCommand("previous");
        return;
      }
      if (target.closest("#compactNext")) {
        event.stopPropagation();
        DI.api?.mediaCommand("next");
        return;
      }
      if (target.closest("#compactPlay")) {
        event.stopPropagation();
        DI.api?.mediaCommand("toggle");
        return;
      }
      if (target.closest("#compactArt") || target.closest("#compactMeta")) {
        DI.openPanel();
      }
    });

    // Clicking anywhere on the pill (or the peek banner) opens the panel;
    // the transport buttons run their own action instead.
    // Scroll over the capsule to ride the volume, with the HUD to confirm.
    $("#compact")?.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const current = Number(state.bridge.volume?.level) || 0;
        const next = DI.clamp(
          current + (event.deltaY > 0 ? -0.05 : 0.05),
          0,
          1
        );
        DI.api?.setVolume(next);
        DI.showVolumeHud?.();
      },
      { passive: false }
    );

    $("#compact")?.addEventListener("click", (event) => {
      if (event.target.closest("#compactPlay, #compactPrev, #compactNext")) return;
      if (performance.now() < suppressClickUntil) return;
      DI.openPanel();
    });
    $("#peek")?.addEventListener("click", () => DI.openPanel());

    $$(".tab").forEach((button) => {
      button.addEventListener("click", () => DI.setTab(button.dataset.tab));
    });

    $("#collapseBtn")?.addEventListener("click", () => DI.closePanel());
    $("#focusQuick")?.addEventListener("click", () => {
      DI.api?.setFocus(!state.focus);
    });
    $("#splitToggle")?.addEventListener("click", () => DI.setSplit(!state.split));

    $("#splitMedia")?.addEventListener("click", () => {
      state.split = false;
      DI.syncLayout();
      DI.openPanel("now");
    });
    $("#splitTimer")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-action]")) return;
      state.split = false;
      DI.syncLayout();
      DI.openPanel("tools");
    });
    $$("#splitTimer [data-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (button.dataset.action === "toggle") DI.toggleTimer?.();
        if (button.dataset.action === "reset") DI.resetTimer?.();
      });
    });

    $("#vitalsHint")?.addEventListener("click", () => DI.openPanel("system"));
    $("#openTools")?.addEventListener("click", () => DI.openPanel("tools"));
    $("#sessionTimerBtn")?.addEventListener("click", () => DI.openPanel("tools"));
    $("#sessionClipBtn")?.addEventListener("click", () => DI.openPanel("tools"));
    $("#sessionActivityBtn")?.addEventListener("click", () => DI.openPanel("live"));

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const peek = $("#peek");
      if (notificationActive) {
        DI.clearNotifications();
        return;
      }
      if (state.panelOpen) {
        DI.closePanel();
      } else if (state.split) {
        DI.setSplit(false);
      } else {
        peek?.classList.remove("is-visible");
      }
    });
  }

  function subscribe() {
    const api = DI.api;
    if (!api) return;
    api.onBridgeState?.(DI.applyBridge);
    api.onStats?.(applyStats);
    api.onNotification?.(DI.notify);
    api.onCollapse?.(() => DI.closePanel(true));
    api.onTogglePanel?.(() => DI.togglePanel());
    api.onOpenTab?.((tab) => DI.openPanel(tab));
    api.onAppInfo?.((info) => {
      if (!info) return;
      state.appInfo = info;
      const tag = $("#buildTag");
      if (tag) tag.textContent = `v${info.version || "1.0"}${info.packaged ? "" : " · dev"}`;
      if (typeof info.focusMode === "boolean") DI.applyFocus(info.focusMode);
    });
    api.onRefreshLayout?.(() => DI.redrawPanels?.());
    api.onFocusState?.(DI.applyFocus);
    api.onClipboard?.((items) => {
      const list = Array.isArray(items) ? items : [];
      const previousLength = state.clipboard?.length || 0;
      const grew = list.length > previousLength;
      const newest = list?.[0];
      state.clipboard = list;
      DI.renderClipboard?.();
      setTabBadge("#tabClipBadge", list.length);
      if (grew && newest && !state.panelOpen && previousLength > 0) {
        smartNotify("clip", {
          app: "Clipboard",
          title: "New clip",
          body: newest.text ? DI.shortName(newest.text, 60) : newest.type,
          icon: newest.type === "link" ? "link" : newest.type === "image" ? "image" : "clipboard",
          duration: 2600,
        }, 5000);
      }
    });
    api.onLauncher?.((items) => {
      state.launcher = Array.isArray(items) ? items : [];
      DI.renderLauncher?.();
    });
    api.onActivities?.((items) => {
      const list = Array.isArray(items) ? items : [];
      const previous = new Map((state.activities || []).map((item) => [item.id, item.status]));
      state.activities = list;
      DI.renderActivities?.();
      setTabBadge("#tabActivityBadge", list.filter((item) => item.status !== "done").length);
      for (const item of list) {
        if (item.status === "done" && previous.get(item.id) !== "done") {
          DI.chime();
          smartNotify(`activity:${item.id}`, {
            app: "Activity",
            title: item.title || "Task complete",
            body: item.subtitle || "",
            icon: "check",
            tone: "success",
            duration: 4200,
          }, 3000);
        }
      }
    });
    api.onFilesDropped?.((items) => {
      if (!Array.isArray(items) || !items.length) return;
      DI.addFiles?.(items);
      // Dropping onto the pill opens the drop shelf so the catch is visible.
      DI.openPanel("tools");
      DI.notify({
        app: "Drop shelf",
        title: `${items.length} file${items.length > 1 ? "s" : ""} shelved`,
        body: items.map((item) => item.name).slice(0, 2).join(" · "),
        tone: "success",
        duration: 3200,
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  setInterval(() => {
    const second = new Date().getSeconds();
    if (second !== lastClockSecond) DI.updateClock();
    DI.tickTimer?.();
    DI.updatePill?.();
  }, 250);

  setInterval(() => {
    if (state.panelOpen && state.tab === "now") DI.tickMedia?.();
  }, 250);

  DI.bindKeys = () => {
    document.addEventListener("keydown", (event) => {
      const tag = event.target?.tagName || "";
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable;

      if (event.key === "Escape" && state.panelOpen) {
        event.preventDefault();
        DI.closePanel();
        return;
      }
      if (!state.panelOpen || typing) return;

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.key === "ArrowLeft" ? -1 : 1;
        const index = TABS.indexOf(state.tab);
        DI.setTab(TABS[(index + step + TABS.length) % TABS.length]);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const current = Number(state.bridge.volume?.level) || 0;
        const next = DI.clamp(
          current + (event.key === "ArrowUp" ? 0.05 : -0.05),
          0,
          1
        );
        DI.api?.setVolume(next);
        DI.showVolumeHud?.();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        DI.api?.mediaCommand("toggle");
      }
    });
  };

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  DI.initCore = async () => {
    bindEvents();
    DI.bindKeys();
    subscribe();
    DI.applyFocus(state.focus);
    DI.setTab("now", false);
    DI.syncLayout();
    DI.updateClock();
    DI.renderMedia?.(state.bridge.media);
    DI.renderAudio?.(state.bridge.audio);
    DI.renderClipboard?.();
    DI.renderLauncher?.();
    DI.renderActivities?.();
    DI.renderTimer?.();
    try {
      const settings = await DI.api.getSettings?.();
      if (settings) {
        DI.applySettings(settings);
        DI.renderSettings?.();
      }
    } catch {}
    DI.api?.rendererReady?.();
    document.fonts?.ready.then(() => DI.setTab(state.tab, false)).catch(() => {});
    requestAnimationFrame(() => DI.redrawPanels?.());
  };
})();
