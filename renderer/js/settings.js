"use strict";

/* Settings page: accent scheme, pill behavior, theme — all persisted. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  const MODE_LABELS = { wallpaper: "WALLPAPER", album: "ALBUM ART", custom: "CUSTOM" };

  let saveTimer = null;

  const persist = (patch) => {
    DI.applySettings(patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      DI.api.saveSettings?.(patch).catch(() => {});
    }, 320);
  };

  function renderMode() {
    const mode = state.settings.accentMode;
    $$("#accentModeSegment button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    });
    const chip = $("#accentModeChip");
    if (chip) chip.textContent = MODE_LABELS[mode] || "WALLPAPER";
    const note = $("#accentNote");
    if (note) {
      note.textContent =
        mode === "custom"
          ? "Your palette drives the whole island, 24/7."
          : mode === "album"
            ? "Only album art changes the accent; the island keeps its default palette otherwise."
            : "Follows your Windows accent or wallpaper. Album art takes over while music plays.";
    }
    const row = $("#colorRow");
    if (row) row.classList.toggle("is-locked", mode !== "custom");
    const accentNow = $("#accentNow");
    if (accentNow) accentNow.textContent = MODE_LABELS[mode] || "WALLPAPER";
  }

  function renderColors() {
    const primary = $("#accentPrimaryInput");
    const secondary = $("#accentSecondaryInput");
    if (primary) primary.value = state.settings.accentPrimary;
    if (secondary) secondary.value = state.settings.accentSecondary;
    const primaryHex = $("#accentPrimaryHex");
    if (primaryHex) primaryHex.textContent = String(state.settings.accentPrimary).toUpperCase();
    const secondaryHex = $("#accentSecondaryHex");
    if (secondaryHex) secondaryHex.textContent = String(state.settings.accentSecondary).toUpperCase();
    const preview = $("#accentPreview");
    if (preview) {
      preview.style.background = `linear-gradient(135deg, ${state.settings.accentPrimary}, ${state.settings.accentSecondary})`;
    }
  }

  function renderSwitches() {
    const toggles = [
      ["#setProgressRing", "progressRing"],
      ["#setHoverExpand", "hoverExpand"],
      ["#setAurora", "aurora"],
      ["#setOdometer", "odometer"],
      ["#setAutoHide", "autoHideFullscreen"],
      ["#setSoundReactive", "soundReactive"],
      ["#setHoloAccent", "holoAccent"],
      ["#setGlassPanel", "glassPanel"],
      ["#setDragTrail", "dragTrail"],
      ["#setAutoTheme", "autoLightDark"],
    ];
    for (const [selector, key] of toggles) {
      const button = $(selector);
      if (!button) continue;
      const off = key === "autoHideFullscreen" || key === "glassPanel";
      const on = off ? Boolean(state.settings[key]) : state.settings[key] !== false;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-checked", on ? "true" : "false");
    }
    const themeNow = $("#themeNow");
    if (themeNow) themeNow.textContent = document.body.classList.contains("light") ? "LIGHT" : "DARK";
  }

  function renderDock() {
    const edge = state.settings.dockEdge || "top";
    $$("#dockEdgeSegment button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.edge === edge);
    });
    const range = $("#dockOffset");
    if (range) range.value = String(Math.round(Number(state.settings.dockOffset || 0) * 100));
    const face = state.settings.capsuleFace || "clock";
    $$("#capsuleFaceSegment button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.face === face);
    });
    const pack = state.settings.themePack || "neon";
    $$("#themePackSegment button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.pack === pack);
    });
  }

  DI.renderSettings = () => {
    renderMode();
    renderColors();
    renderSwitches();
    renderDock();
  };

  /* Keeps the CONFIG page in sync when the island is dragged somewhere. */
  DI.onIslandDocked = (edge, offset) => {
    state.settings.dockEdge = edge || "top";
    state.settings.dockOffset = Number(offset) || 0;
    renderDock();
  };

  function initSettings() {
    $("#accentModeSegment")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button) return;
      persist({ accentMode: button.dataset.mode });
      renderMode();
    });

    const onColor = (key, inputId, hexId) => {
      const input = $(inputId);
      input?.addEventListener("input", () => {
        if (state.settings.accentMode !== "custom") persist({ accentMode: "custom" });
        persist({ [key]: input.value });
        renderMode();
        renderColors();
      });
    };
    onColor("accentPrimary", "#accentPrimaryInput", "#accentPrimaryHex");
    onColor("accentSecondary", "#accentSecondaryInput", "#accentSecondaryHex");

    const onToggle = (selector, key) => {
      $(selector)?.addEventListener("click", () => {
        persist({ [key]: state.settings[key] === false });
        renderSwitches();
      });
    };
    onToggle("#setProgressRing", "progressRing");
    onToggle("#setHoverExpand", "hoverExpand");
    onToggle("#setAurora", "aurora");
    onToggle("#setOdometer", "odometer");
    onToggle("#setAutoHide", "autoHideFullscreen");
    onToggle("#setAutoTheme", "autoLightDark");
    onToggle("#setStartLogin", "launchAtLogin");

    $("#dockEdgeSegment")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edge]");
      if (!button) return;
      const edge = button.dataset.edge || "top";
      state.settings.dockEdge = edge;
      DI.dockIsland?.(edge, Number(state.settings.dockOffset) || 0);
      renderDock();
    });

    $("#dockOffset")?.addEventListener("input", (event) => {
      const value = Number(event.target.value) / 100;
      state.settings.dockOffset = value;
      DI.dockIsland?.(state.settings.dockEdge || "top", value);
    });

    $("#capsuleFaceSegment")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-face]");
      if (!button) return;
      const face = button.dataset.face || "clock";
      state.settings.capsuleFace = face;
      persist({ capsuleFace: face });
      DI.applySettings?.(state.settings);
      renderDock();
    });

    $("#themePackSegment")?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-pack]");
      if (!button) return;
      const pack = button.dataset.pack || "neon";
      state.settings.themePack = pack;
      persist({ themePack: pack });
      DI.applySettings?.(state.settings);
      renderDock();
    });

    DI.renderSettings();
  }

  DI.inits.push(initSettings);
})();
