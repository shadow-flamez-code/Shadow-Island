"use strict";

/* Tools page: drop shelf, clipboard history, launch bay, timer. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  const MAX_FILES = 24;
  const KNOWN_ICONS = new Set([
    "folder", "terminal", "gear", "calculator", "note", "pulse", "camera", "globe",
    "music", "code", "gamepad", "app", "output", "wifi", "activity",
  ]);

  function fileKind(ext) {
    const value = String(ext || "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "psd"].includes(value)) return "image";
    if (["mp4", "mov", "mkv", "webm", "avi", "prproj"].includes(value)) return "video";
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(value)) return "audio";
    if (["zip", "rar", "7z", "tar", "gz"].includes(value)) return "archive";
    return "doc";
  }

  function fileExtLabel(item) {
    if (item.isDir) return "DIR";
    return (item.ext || "file").slice(0, 4).toUpperCase();
  }

  /* ---------------------------------------------------------------- */
  /* Drop shelf                                                        */
  /* ---------------------------------------------------------------- */

  function renderFiles() {
    const list = $("#dropList");
    if (!list) return;
    list.textContent = "";
    const files = state.files;
    const total = files.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    $("#dropCount").textContent = `${files.length} file${files.length === 1 ? "" : "s"} shelved`;
    $("#dropSize").textContent = files.length ? DI.fmtBytes(total) : "0 B";

    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "empty-slot";
      empty.id = "dropEmpty";
      empty.innerHTML = `${DI.icon("download")}<span>No files yet — drop something</span>`;
      list.append(empty);
      return;
    }

    for (const item of files) {
      const chip = document.createElement("div");
      chip.className = "file-chip";
      chip.dataset.kind = fileKind(item.ext);
      chip.title = item.path || item.name;
      chip.innerHTML = `
        <span class="file-ext"></span>
        <span class="file-meta"><b></b><small></small></span>
        <span class="file-actions">
          <button class="file-act" type="button" data-act="reveal" title="Show in folder">${DI.icon("folder")}</button>
          <button class="file-act" type="button" data-act="remove" title="Remove from shelf">${DI.icon("close")}</button>
        </span>`;
      chip.querySelector(".file-ext").textContent = fileExtLabel(item);
      chip.querySelector(".file-meta b").textContent = item.name;
      chip.querySelector(".file-meta small").textContent = item.isDir
        ? "Folder"
        : `${DI.fmtBytes(item.size)} · ${item.dir || "Drop shelf"}`;
      chip.addEventListener("click", (event) => {
        if (event.target.closest("[data-act]")) return;
        if (item.path) DI.api.openPath(item.path);
      });
      chip.querySelector('[data-act="reveal"]').addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.path) DI.api.revealPath(item.path);
      });
      chip.querySelector('[data-act="remove"]').addEventListener("click", (event) => {
        event.stopPropagation();
        state.files = state.files.filter((entry) => entry.path !== item.path);
        renderFiles();
      });
      list.append(chip);
    }
  }

  DI.addFiles = (items) => {
    if (!Array.isArray(items) || !items.length) return;
    const seen = new Set(state.files.map((item) => item.path));
    for (const item of items) {
      if (!item?.path || seen.has(item.path)) continue;
      state.files.unshift(item);
      seen.add(item.path);
    }
    state.files = state.files.slice(0, MAX_FILES);
    renderFiles();
    DI.openPanel?.("tools");
  };

  /* ---------------------------------------------------------------- */
  /* Clipboard                                                         */
  /* ---------------------------------------------------------------- */

  let clipFilter = "";

  function renderClipboard() {
    const list = $("#clipList");
    if (!list) return;
    const all = state.clipboard;
    $("#clipCount").textContent = String(all.length);
    list.textContent = "";

    const needle = clipFilter.trim().toLowerCase();
    const items = needle
      ? all.filter(
          (item) =>
            (item.text || "").toLowerCase().includes(needle) || item.type.includes(needle)
        )
      : all;

    if (!items.length) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = needle
        ? "No clips match your search."
        : "Copy text, a link, or an image and it lands here.";
      list.append(note);
      updateSessionCounts();
      return;
    }

    items.slice(0, 24).forEach((item) => {
      const row = document.createElement("div");
      row.className = `clip-row${item.pinned ? " is-pinned" : ""}${
        item.type === "link" ? " is-link" : item.type === "image" ? " is-image" : ""
      }`;
      row.title = item.type === "image" ? "Click to copy image" : "Click to copy";
      row.dataset.clipId = item.id;
      row.innerHTML = `
        <span class="clip-kind"></span>
        <span class="clip-body"><span class="clip-text"></span><span class="clip-time"></span></span>
        <span class="clip-actions">
          <button class="clip-act" type="button" data-act="pin" title="Pin">${DI.icon("pin")}</button>
          <button class="clip-act" type="button" data-act="delete" title="Delete">${DI.icon("trash")}</button>
        </span>`;
      const kind = row.querySelector(".clip-kind");
      if (item.type === "image" && item.dataUrl) {
        const img = document.createElement("img");
        img.src = item.dataUrl;
        img.alt = "";
        kind.append(img);
      } else {
        kind.innerHTML = DI.icon(item.type === "link" ? "link" : "copy");
      }
      row.querySelector(".clip-text").textContent =
        item.text || (item.type === "image" ? "Image" : "Untitled clip");
      row.querySelector(".clip-time").textContent = `${item.type} · ${DI.relTime(item.at)}`;
      row.querySelector('[data-act="pin"]').classList.toggle("is-pinned", Boolean(item.pinned));
      row.querySelector('[data-act="pin"]').title = item.pinned ? "Unpin" : "Pin";

      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-act]")) return;
        DI.api.copyClipboard(item.id);
        row.classList.add("is-copied");
        setTimeout(() => row.classList.remove("is-copied"), 650);
      });
      row.querySelector('[data-act="pin"]').addEventListener("click", (event) => {
        event.stopPropagation();
        DI.api.pinClipboard(item.id);
      });
      row.querySelector('[data-act="delete"]').addEventListener("click", (event) => {
        event.stopPropagation();
        DI.api.deleteClipboard(item.id);
      });
      list.append(row);
    });
    updateSessionCounts();
  }

  /* ---------------------------------------------------------------- */
  /* Launcher                                                          */
  /* ---------------------------------------------------------------- */

  function renderLauncher() {
    const grid = $("#appGrid");
    if (!grid) return;
    grid.textContent = "";

    for (const item of state.launcher) {
      const tile = document.createElement("button");
      tile.className = `app-tile${item.builtin ? "" : " is-custom"}`;
      tile.type = "button";
      tile.title = item.name;
      const iconName = KNOWN_ICONS.has(item.icon) ? item.icon : "app";
      tile.innerHTML = `${DI.icon(iconName)}<span></span>${
        item.builtin ? "" : `<span class="app-remove" title="Remove">${DI.icon("close")}</span>`
      }`;
      tile.querySelector("span").textContent = item.name;
      tile.addEventListener("click", (event) => {
        if (event.target.closest(".app-remove")) return;
        DI.api.launchApp(item.id);
      });
      tile.querySelector(".app-remove")?.addEventListener("click", (event) => {
        event.stopPropagation();
        DI.api.removeLauncherApp(item.id);
      });
      grid.append(tile);
    }

    const add = document.createElement("button");
    add.className = "app-tile is-add";
    add.type = "button";
    add.innerHTML = `${DI.icon("plus")}<span>ADD APP</span>`;
    add.addEventListener("click", () => addLauncherApp());
    grid.append(add);
  }

  async function addLauncherApp() {
    try {
      await DI.api.addLauncherApp();
    } catch {}
  }

  async function saveLink() {
    const name = $("#linkName").value.trim();
    const url = $("#linkUrl").value.trim();
    if (!/^https?:\/\//i.test(url)) {
      $("#linkUrl").focus();
      return;
    }
    try {
      await DI.api.addLauncherUrl({ name, url });
      $("#linkName").value = "";
      $("#linkUrl").value = "";
      $("#linkForm").classList.remove("is-open");
    } catch {}
  }

  /* ---------------------------------------------------------------- */
  /* Timer                                                             */
  /* ---------------------------------------------------------------- */

  const timer = (state.timer = {
    mode: "pomodoro",
    total: 1500,
    remaining: 1500,
    running: false,
    endsAt: 0,
    elapsed: 0,
    stopwatchStartedAt: 0,
    stopwatchBase: 0,
    fired: false,
  });

  function timerValue() {
    return timer.mode === "stopwatch" ? timer.elapsed : timer.remaining;
  }

  function renderTimer() {
    const mode = timer.mode;
    const value = timerValue();
    const display = DI.fmtClock(value);
    const running = timer.running;

    $("#timerDisplay").textContent = mode === "stopwatch" ? DI.fmtClock(timer.elapsed) : display;
    $("#timerModeChip").textContent = mode === "stopwatch" ? "STOPWATCH" : running ? "RUNNING" : "POMODORO";
    const sessionTimerEl = $("#sessionTimer");
    if (sessionTimerEl) sessionTimerEl.textContent = display;

    let label = "Deep work · ready";
    if (mode === "stopwatch") {
      label = timer.elapsed > 0 ? (running ? "Elapsed · running" : "Elapsed · paused") : "Stopwatch · ready";
    } else if (timer.remaining <= 0) {
      label = "Session complete · take a break";
    } else if (timer.remaining < timer.total) {
      label = running ? "Deep work · in progress" : "Paused · continue when ready";
    }
    $("#timerLabel").textContent = label;

    DI.setIcon($("#timerStartIcon"), running ? "pause" : "play");
    $("#timerStartLabel").textContent = running ? "PAUSE" : timerValue() < timer.total && mode === "pomodoro" ? "RESUME" : "START";
    $("#timerStart").classList.toggle("is-running", running);

    $$(".timer-presets .preset").forEach((button) => {
      const isStopwatch = button.dataset.mode === "stopwatch";
      const active = isStopwatch ? mode === "stopwatch" : mode === "pomodoro" && Number(button.dataset.preset) === timer.total;
      button.classList.toggle("is-active", active);
    });

    const visible = running || (mode === "pomodoro" && timer.remaining < timer.total) || (mode === "stopwatch" && timer.elapsed > 0);
    const compactTimer = $("#compactTimer");
    if (compactTimer) {
      compactTimer.hidden = !visible;
      compactTimer.querySelector("b").textContent = display;
    }
    $("#splitTimerTime").textContent = mode === "stopwatch" ? DI.fmtClock(timer.elapsed) : display;
    $("#splitTimerLabel").textContent = mode === "stopwatch" ? "Stopwatch" : "Focus session";
    DI.updatePill?.();
  }

  DI.tickTimer = () => {
    const now = Date.now();
    if (timer.mode === "pomodoro" && timer.running) {
      timer.remaining = Math.max(0, (timer.endsAt - now) / 1000);
      if (timer.remaining <= 0) {
        timer.running = false;
        if (!timer.fired) {
          timer.fired = true;
          DI.chime();
          DI.notify({
            app: "Focus",
            title: "Focus session complete",
            body: "Nice work. Take five — the island will keep watch.",
            tone: "success",
            icon: "timer",
            duration: 6000,
          });
        }
      }
      renderTimer();
    } else if (timer.mode === "stopwatch" && timer.running) {
      timer.elapsed = timer.stopwatchBase + (now - timer.stopwatchStartedAt) / 1000;
      renderTimer();
    }
  };

  DI.toggleTimer = () => {
    const now = Date.now();
    if (timer.mode === "pomodoro") {
      if (timer.running) {
        timer.remaining = Math.max(0, (timer.endsAt - now) / 1000);
        timer.running = false;
      } else {
        if (timer.remaining <= 0) timer.remaining = timer.total;
        timer.endsAt = now + timer.remaining * 1000;
        timer.running = true;
        timer.fired = false;
      }
    } else if (timer.running) {
      timer.stopwatchBase = timer.elapsed;
      timer.running = false;
    } else {
      timer.stopwatchStartedAt = now;
      timer.stopwatchBase = timer.elapsed;
      timer.running = true;
    }
    renderTimer();
  };

  DI.resetTimer = () => {
    timer.running = false;
    timer.fired = false;
    timer.remaining = timer.total;
    timer.elapsed = 0;
    timer.stopwatchBase = 0;
    renderTimer();
  };

  DI.renderTimer = renderTimer;
  DI.renderFiles = renderFiles;
  DI.renderClipboard = renderClipboard;
  DI.renderLauncher = renderLauncher;

  /* ---------------------------------------------------------------- */
  /* Session counters                                                  */
  /* ---------------------------------------------------------------- */

  function updateSessionCounts() {
    const clips = $("#sessionClips");
    if (clips) clips.textContent = String(state.clipboard.length);
    const activities = $("#sessionActivities");
    if (activities) activities.textContent = String(state.activities.length);
  }
  DI.updateSessionCounts = updateSessionCounts;

  /* ---------------------------------------------------------------- */
  /* Bind                                                              */
  /* ---------------------------------------------------------------- */

  function initTools() {
    if (DI.isPreview && !DI.mockIdle) {
      const previewParams = new URLSearchParams(window.location.search);
      const mediaOnly = previewParams.get("noActivities") === "1";
      if (!mediaOnly) {
        timer.remaining = 1122;
        timer.running = true;
        timer.endsAt = Date.now() + 1122 * 1000;
      }
    }
    renderFiles();
    renderClipboard();
    renderLauncher();
    renderTimer();

    $("#clipClear")?.addEventListener("click", () => DI.api.clearClipboard());
    $("#clipSearch")?.addEventListener("input", (event) => {
      clipFilter = event.target.value;
      renderClipboard();
    });
    $("#appAddBtn")?.addEventListener("click", addLauncherApp);
    $("#appAddLinkBtn")?.addEventListener("click", () => {
      $("#linkForm")?.classList.toggle("is-open");
      if ($("#linkForm")?.classList.contains("is-open")) $("#linkName")?.focus();
    });
    $("#linkSave")?.addEventListener("click", saveLink);
    $("#linkUrl")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveLink();
    });
    $("#linkForm")?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") $("#linkForm").classList.remove("is-open");
    });

    $("#timerStart")?.addEventListener("click", DI.toggleTimer);
    $("#timerReset")?.addEventListener("click", DI.resetTimer);

    // Notes pad — autosaves (debounced) to userData/notes.txt.
    const notesArea = $("#notesArea");
    const notesStatus = $("#notesStatus");
    let notesTimer = null;
    const saveNotes = async () => {
      if (!notesArea) return;
      if (notesStatus) notesStatus.textContent = "SAVING…";
      try {
        await DI.api.saveNotes?.(notesArea.value);
        if (notesStatus) notesStatus.textContent = "SAVED";
      } catch {
        if (notesStatus) notesStatus.textContent = "FAILED";
      }
    };
    notesArea?.addEventListener("input", () => {
      if (notesStatus) notesStatus.textContent = "TYPING…";
      clearTimeout(notesTimer);
      notesTimer = setTimeout(saveNotes, 500);
    });
    DI.api.getNotes?.().then((value) => {
      if (notesArea && !notesArea.value) notesArea.value = String(value || "");
    }).catch(() => {});
    $$(".timer-presets .preset").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.mode === "stopwatch") {
          timer.mode = "stopwatch";
          timer.running = false;
          timer.elapsed = 0;
          timer.stopwatchBase = 0;
        } else {
          const total = Number(button.dataset.preset) || 1500;
          timer.mode = "pomodoro";
          timer.total = total;
          timer.remaining = total;
          timer.running = false;
          timer.fired = false;
        }
        renderTimer();
      });
    });

    // Browser-only fallback so the drop shelf can be tested without Electron.
    if (DI.isPreview && !window.islandAPI) {
      const zone = $("#dropZone");
      document.addEventListener("dragover", (event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        zone?.classList.add("is-dragover");
      });
      document.addEventListener("dragleave", (event) => {
        if (!event.relatedTarget) zone?.classList.remove("is-dragover");
      });
      document.addEventListener("drop", (event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        zone?.classList.remove("is-dragover");
        const files = [...event.dataTransfer.files].slice(0, 20).map((file) => ({
          path: file.name,
          name: file.name,
          dir: "Browser preview",
          size: file.size,
          isDir: false,
          ext: file.name.split(".").pop()?.slice(0, 8).toLowerCase() || "",
          at: Date.now(),
        }));
        DI.addFiles(files);
      });
    }
  }

  DI.inits.push(initTools);
})();
