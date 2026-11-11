"use strict";

/* Extras: smart clipboard actions, per-app accents, the edge-swipe mini
   player and the screenshot shelf. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  /* ---------------------------------------------------------------- */
  /* Smart clipboard                                                     */
  /* ---------------------------------------------------------------- */

  const CODE_HINTS = /(\bfunction\b|\bconst\b|\bdef\b|\bclass\b|=>|\{\s*[\w"']+\s*:|;\s*$|\bimport\b|\bfrom\b)/m;

  function classify(text) {
    const value = String(text || "").trim();
    if (!value) return [];
    if (/^https?:\/\/\S+$/i.test(value) || /^www\.\S+$/i.test(value)) {
      return [
        { id: "open", label: "OPEN" },
        { id: "search", label: "SEARCH" },
        { id: "copy", label: "COPY" },
      ];
    }
    if (/^[\d\s+\-*/().,^%]+$/.test(value) && /\d/.test(value) && /[+\-*/^]/.test(value)) {
      return [
        { id: "calc", label: "CALC" },
        { id: "copy", label: "COPY" },
      ];
    }
    if (CODE_HINTS.test(value) && value.length > 24) {
      return [
        { id: "format", label: "FORMAT" },
        { id: "search", label: "SEARCH" },
        { id: "copy", label: "COPY" },
      ];
    }
    return [
      { id: "search", label: "SEARCH" },
      { id: "translate", label: "TRANSLATE" },
      { id: "copy", label: "COPY" },
    ];
  }

  DI.smartClipActions = (item) => {
    if (!item || item.type === "image") return [];
    return classify(item.text);
  };

  function runSmartAction(action, item) {
    const text = String(item?.text || "").trim();
    const url = /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^www\./i, "www.")}`;
    if (action === "open" && item?.type === "link") {
      DI.api.openExternal?.(url);
      return;
    }
    if (action === "search") {
      DI.api.openExternal?.(`https://www.google.com/search?q=${encodeURIComponent(text)}`);
      return;
    }
    if (action === "translate") {
      DI.api.openExternal?.(
        `https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(text)}`
      );
      return;
    }
    if (action === "calc") {
      DI.api.launchApp?.("calculator");
      return;
    }
    if (action === "format") {
      try {
        const parsed = JSON.parse(text);
        DI.api.writeClipboard?.(JSON.stringify(parsed, null, 2));
        DI.notify?.({
          app: "Shadow Island",
          title: "JSON formatted",
          body: "The pretty version is on your clipboard.",
          tone: "success",
        });
      } catch {
        DI.notify?.({
          app: "Shadow Island",
          title: "Not JSON",
          body: "That snippet is not valid JSON.",
          tone: "power",
        });
      }
      return;
    }
    if (action === "copy") DI.api.copyClipboard?.(item?.id);
  }

  DI.runSmartAction = runSmartAction;

  /* ---------------------------------------------------------------- */
  /* Per app accents                                                    */
  /* ---------------------------------------------------------------- */

  const APP_ACCENTS = [
    [/spotify/i, "#1ED760", "#0f3d1c"],
    [/chrome/i, "#4285F4", "#1a2b52"],
    [/edge/i, "#00A4EF", "#06283a"],
    [/firefox/i, "#FF7139", "#4a1a08"],
    [/youtube/i, "#FF0033", "#4a0010"],
    [/vlc/i, "#FF8800", "#4a2d00"],
    [/discord/i, "#5865F2", "#1b1f4d"],
    [/telegram/i, "#2AABEE", "#0a3a49"],
    [/apple music|itunes/i, "#FA243C", "#4a0c17"],
    [/deezer/i, "#A238FF", "#33104a"],
    [/vscode|visual studio code/i, "#22A0EA", "#0b3category"],
    [/teams/i, "#7B83EB", "#2a2d55"],
    [/zoom/i, "#2D8CFF", "#0b2a4a"],
    [/notion/i, "#E8E8EA", "#2a2a2e"],
    [/obs/i, "#FFFFFF", "#3a3a40"],
    [/windows media|media player/i, "#00A4EF", "#06283a"],
  ];

  function appAccent(appId) {
    const name = String(appId || "");
    if (!name) return null;
    for (const [pattern, primary, secondary] of APP_ACCENTS) {
      if (pattern.test(name)) return { primary, secondary };
    }
    return null;
  }

  function applyAppAccent() {
    const media = state.bridge.media;
    const accent = appAccent(media?.appId || media?.app || "");
    const root = document.documentElement;
    if (accent) {
      root.style.setProperty("--app-accent", accent.primary);
      root.style.setProperty("--app-accent-2", accent.secondary);
      document.body.classList.add("has-app-accent");
    } else {
      root.style.removeProperty("--app-accent");
      root.style.removeProperty("--app-accent-2");
      document.body.classList.remove("has-app-accent");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Edge swipe mini player                                             */
  /* ---------------------------------------------------------------- */

  let swipeStart = null;

  function bindEdgeSwipe() {
    const compact = $("#compact");
    if (!compact) return;

    compact.addEventListener(
      "pointerdown",
      (event) => {
        if (event.ctrlKey && event.shiftKey) return;
        swipeStart = { x: event.clientX, y: event.clientY, moved: false };
      },
      true
    );

    window.addEventListener("pointermove", (event) => {
      if (!swipeStart) return;
      const dx = event.clientX - swipeStart.x;
      const dy = event.clientY - swipeStart.y;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swipeStart.moved = true;
        setMiniPlayer(!document.body.classList.contains("is-mini"));
      }
    });

    window.addEventListener("pointerup", () => {
      swipeStart = null;
    });
  }

  function setMiniPlayer(on) {
    document.body.classList.toggle("is-mini", Boolean(on));
    DI.reportWindowBox?.(0);
  }

  DI.setMiniPlayer = setMiniPlayer;

  /* ---------------------------------------------------------------- */
  /* Screenshot shelf                                                   */
  /* ---------------------------------------------------------------- */

  async function captureScreen() {
    const button = $("#captureScreen");
    if (button) button.classList.add("is-busy");
    try {
      const dataUrl = await DI.api.captureScreen?.();
      if (!dataUrl) {
        DI.notify?.({
          app: "Shadow Island",
          title: "Capture failed",
          body: "The screen could not be grabbed.",
          tone: "power",
        });
        return;
      }
      DI.api.addClipboardImage?.(dataUrl);
      DI.notify?.({
        app: "Shadow Island",
        title: "Screen captured",
        body: "The screenshot is waiting in your clipboard shelf.",
        tone: "success",
        duration: 3200,
      });
    } finally {
      if (button) button.classList.remove("is-busy");
    }
  }

  DI.captureScreen = captureScreen;

  /* ---------------------------------------------------------------- */
  /* Boot                                                               */
  /* ---------------------------------------------------------------- */

  function initExtras() {
    bindEdgeSwipe();
    applyAppAccent();

    const originalMedia = DI.renderMedia;
    DI.renderMedia = (media) => {
      originalMedia?.(media);
      applyAppAccent();
    };

    $("#captureScreen")?.addEventListener("click", (event) => {
      event.stopPropagation();
      captureScreen();
    });

    const originalRender = DI.renderClipboard;    DI.renderClipboard = () => {
      originalRender?.();
      // Attach the smart action chips to every clip row.
      for (const row of $$(".clip-row")) {
        const id = row.dataset.clipId;
        const item = state.clipboard.find((entry) => entry.id === id);
        const actions = DI.smartClipActions(item);
        if (!actions?.length || row.querySelector(".clip-smart")) continue;
        const host = document.createElement("span");
        host.className = "clip-smart";
        for (const action of actions) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "clip-smart-chip";
          chip.dataset.smart = action.id;
          chip.textContent = action.label;
          chip.addEventListener("click", (event) => {
            event.stopPropagation();
            runSmartAction(action.id, item);
          });
          host.append(chip);
        }
        row.append(host);
      }
    };
  }

  DI.initExtras = initExtras;
  DI.inits.push(initExtras);
})();
