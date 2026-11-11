"use strict";

/* Media card, transport, output volume, waveform and synced lyrics. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  let artworkKey = "";
  let artworkUrl = "";
  let seekDragging = false;
  let lyricScrolling = false;
  let waveFrame = 0;
  let wavePhase = 0;

  const PLAY_ICON = (playing) => (playing ? "pause" : "play");

  /* ---------------------------------------------------------------- */
  /* Accent theming — sample the artwork's dominant hue and drive the  */
  /* panel aura, pill ring, play button and active tab through CSS     */
  /* variables, iOS-style. Throttled to actual track changes only.     */
  /* ---------------------------------------------------------------- */

  let accentForUrl = "";

  function extractAccent(url) {
    if (!url) {
      accentForUrl = "";
      setAccentColors(null, null);
      return;
    }
    if (url === accentForUrl) return;
    accentForUrl = url;
    const img = new Image();
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const delta = max - min;
          if (max < 0.15 || delta < 0.12) continue; // skip near-black/grey
          let hue = 0;
          if (max === r) hue = ((g - b) / delta) % 6;
          else if (max === g) hue = (b - r) / delta + 2;
          else hue = (r - g) / delta + 4;
          hue = Math.round(((hue * 60) + 360) % 360);
          const key = Math.round(hue / 12);
          buckets.set(key, { hue, weight: (buckets.get(key)?.weight || 0) + 1 });
        }
        let best = null;
        for (const entry of buckets.values()) {
          if (!best || entry.weight > best.weight) best = entry;
        }
        if (!best) return;
        const primary = `hsl(${best.hue} 72% 62%)`;
        const secondary = `hsl(${(best.hue + 38) % 360} 82% 58%)`;
        setAccentColors(primary, secondary);
      } catch {}
    };
    img.onerror = () => {};
    img.src = url;
  }

  function setAccentColors(primary, secondary) {
    const root = document.documentElement;
    const settings = state.settings;
    let p = primary;
    let s = secondary;
    // Precedence: custom palette > album art (while playing) > wallpaper.
    // In "album" mode there is no wallpaper fallback — CSS defaults apply.
    if (settings?.accentMode === "custom") {
      p = settings.accentPrimary;
      s = settings.accentSecondary;
    } else if (!p && settings?.accentMode !== "album") {
      const wall = state.bridge.system?.wallpaperAccent || null;
      if (wall) {
        p = wall.primary;
        s = wall.secondary;
      }
    }
    if (p) {
      root.style.setProperty("--accent", p);
      root.style.setProperty("--accent-2", s);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-2");
    }
    const active = state.bridge.media;
    if (active?.playing && p) {
      $("#compact")?.style.setProperty("--pill-ring", p);
    }
  }

  // When nothing is playing, keep the accent on the wallpaper palette.
  DI.refreshWallpaperAccent = () => {
    if (!state.bridge.media?.active) setAccentColors(null, null);
  };

  // Re-derive the album accent (used when settings change).
  DI.reapplyAccent = () => {
    const media = state.bridge.media;
    if (media?.active && media.artwork) {
      accentForUrl = "";
      extractAccent(media.artwork);
    } else {
      setAccentColors(null, null);
    }
  };

  function setArtwork(media) {
    const imgs = ["#compactArtImg", "#splitArt", "#albumArt"].map((selector) => $(selector));
    const url = media?.artwork || "";
    const key = media ? media.trackKey || `${media.title}|${media.artist}` : "";
    if (key === artworkKey && url === artworkUrl) return;
    // Some polls deliver no artwork for the same track. Keep showing the
    // last good art instead of flashing back to the idle picture.
    if (key === artworkKey && !url && imgs.some((img) => img && img.getAttribute("src"))) return;
    artworkKey = key;
    artworkUrl = url;
    extractAccent(url);
    for (const img of imgs) {
      if (!img) continue;
      // The idle picture stays visible until the new art has decoded.
      img.classList.add("is-empty");
      if (url) {
        if (img.getAttribute("src") !== url) img.src = url;
        if (img.complete && img.naturalWidth > 0) img.classList.remove("is-empty");
      } else {
        img.removeAttribute("src");
      }
    }
    const album = $("#albumArt");
    album?.closest(".media-art")?.classList.toggle("has-art", Boolean(url));
  }

  function initArtworkLoad() {
    for (const selector of ["#compactArtImg", "#splitArt", "#albumArt"]) {
      const img = $(selector);
      if (!img) continue;
      img.addEventListener("load", () => {
        if (img.getAttribute("src")) img.classList.remove("is-empty");
      });
      img.addEventListener("error", () => img.classList.add("is-empty"));
    }
  }

  DI.renderMedia = (media) => {
    const active = Boolean(media?.active);
    const playing = Boolean(media?.playing);
    const title = active ? media.title || "Unknown track" : "Nothing playing";
    const artist = active
      ? media.artist || media.album || "Unknown artist"
      : "Start a track in any media app";
    const app = active ? media.app || "Windows media session" : "Windows media session";

    setArtwork(media);

    $("#compactTitle").textContent = title;
    $("#compactArtist").textContent = active ? artist : "No active session";
    $("#splitTitle").textContent = title;
    $("#splitArtist").textContent = active ? artist : "No active session";
    $("#trackTitle").textContent = title;
    $("#trackArtist").textContent = active ? artist : "Play something to populate the island";
    $("#mediaApp").textContent = app;

    document.body.classList.toggle("is-playing", playing);

    DI.setIcon($("#compactPlayIcon"), PLAY_ICON(playing));
    DI.setIcon($("#playIcon"), PLAY_ICON(playing));

    // The capsule shows the mark of whatever is playing.
    const appBadge = $("#compactApp");
    if (appBadge) {
      const appName = String(app || media?.appId || "").toLowerCase();
      let glyph = "i-music";
      if (appName.includes("chrome") || appName.includes("edge") || appName.includes("firefox")) glyph = "i-globe";
      else if (appName.includes("youtube") || appName.includes("video")) glyph = "i-video";
      else if (appName.includes("code") || appName.includes("studio")) glyph = "i-code";
      else if (appName.includes("terminal") || appName.includes("cmd")) glyph = "i-terminal";
      else if (appName.includes("telegram") || appName.includes("discord")) glyph = "i-spark";
      const use = appBadge.querySelector("use");
      if (use && use.getAttribute("href") !== `#${glyph}`) {
        use.setAttribute("href", `#${glyph}`);
        appBadge.setAttribute("title", app || "Now playing");
      }
    }

    const prev = $("#compactPrev");
    const next = $("#compactNext");
    if (prev) prev.disabled = !active || media?.canPrevious === false;
    if (next) next.disabled = !active || media?.canNext === false;

    const duration = active ? Math.max(0, Number(media.duration) || 0) : 0;
    const seek = $("#seek");
    if (seek && !seekDragging) {
      seek.max = String(Math.max(1, Math.round(duration * 10)));
      seek.value = String(Math.round(DI.positionNow() * 10));
      DI.setRangeFill(seek);
    }
    if (!seekDragging) {
      $("#elapsed").textContent = DI.fmtTime(active ? DI.positionNow() : 0);
      $("#duration").textContent = DI.fmtTime(duration);
    }

    const canSeek = active && media.canSeek !== false;
    if (seek) seek.disabled = !canSeek;
    $("#prevBtn").disabled = !active || media?.canPrevious === false;
    $("#nextBtn").disabled = !active || media?.canNext === false;

    if (active) {
      const key = media.trackKey || `${media.title}|${media.artist}`;
      if (state.lyrics.trackKey !== key) loadLyrics(media, key);
    } else if (state.lyrics.trackKey) {
      state.lyrics = { synced: [], plain: "", matched: null, source: "", trackKey: "", status: "idle" };
      state.activeLyric = -1;
      renderLyrics();
    }
  };

  DI.tickMedia = () => {
    const media = state.bridge.media;
    if (!media?.active) return;
    const position = DI.positionNow();
    const duration = Math.max(0, Number(media.duration) || 0);
    const seek = $("#seek");
    if (seek && !seekDragging) {
      seek.value = String(Math.round(position * 10));
      DI.setRangeFill(seek);
    }
    if (!seekDragging) {
      $("#elapsed").textContent = DI.fmtTime(position);
      $("#duration").textContent = DI.fmtTime(duration);
    }
    highlightLyric(position);
  };

  /* ---------------------------------------------------------------- */
  /* Waveform                                                          */
  /* ---------------------------------------------------------------- */

  function drawWave() {
    waveFrame = 0;
    if (!state.panelOpen || state.tab !== "now") return;
    const canvas = $("#waveform");
    if (!canvas) return;
    const baked = DI.dprCanvas(canvas);
    if (!baked) return;
    const { ctx, width, height } = baked;
    ctx.clearRect(0, 0, width, height);

    const playing = Boolean(state.bridge.media?.playing);
    const now = performance.now() / 1000;
    // Bars breathe with the system volume (flat when muted/idle).
    const volume = state.bridge.volume;
    const loudness = volume.muted ? 0.14 : 0.35 + (Number(volume.level) || 0) * 0.65;

    // Background spectrum grid
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i += 1) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const bars = Math.max(32, Math.floor(width / 5.5));
    const gap = 1.6;
    const barWidth = Math.max(1, width / bars - gap);

    for (let i = 0; i < bars; i += 1) {
      const x = i * (barWidth + gap);
      const center = Math.abs(i / bars - 0.5) * 2;
      let level;
      if (playing) {
        const wave =
          Math.sin(i * 0.5 + now * 4) * 0.3 +
          Math.sin(i * 1.3 - now * 2.6) * 0.25 +
          Math.sin(i * 0.9 + now * 6.4) * 0.2 +
          Math.sin(i * 2.1 - now * 1.3) * 0.15;
        level = (0.18 + Math.abs(wave) * 0.5 + (1 - center) * 0.22) * loudness;
      } else {
        level = 0.05 + Math.abs(Math.sin(i * 0.8 + now * 0.5)) * 0.03;
      }
      level = DI.clamp(level, 0.02, 1);
      const barHeight = Math.max(1.5, level * (height - 3));
      const y = (height - barHeight) / 2;
      const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
      gradient.addColorStop(0, playing ? "rgba(34,211,238,0.95)" : "rgba(110,108,140,0.45)");
      gradient.addColorStop(0.5, playing ? "rgba(168,85,247,0.95)" : "rgba(100,98,130,0.35)");
      gradient.addColorStop(1, playing ? "rgba(244,114,182,0.9)" : "rgba(90,88,120,0.25)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      const radius = Math.min(barWidth / 2, 1.4);
      ctx.roundRect(x, y, barWidth, barHeight, radius);
      ctx.fill();

      // Glow for top of bars when playing
      if (playing && level > 0.6) {
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.beginPath();
        ctx.roundRect(x, y - 1, barWidth, 1.5, 0.7);
        ctx.fill();
      }
    }

    // Center frequency marker line
    if (playing) {
      const cx = width / 2;
      const lineGradient = ctx.createLinearGradient(0, 0, 0, height);
      lineGradient.addColorStop(0, "transparent");
      lineGradient.addColorStop(0.5, "rgba(34,211,238,0.35)");
      lineGradient.addColorStop(1, "transparent");
      ctx.fillStyle = lineGradient;
      ctx.fillRect(cx - 1, 0, 2, height);
    }

    if (playing || state.panelOpen) waveFrame = requestAnimationFrame(drawWave);
  }

  DI.startWave = () => {
    waveFrame ||= requestAnimationFrame(drawWave);
  };

  /* ---------------------------------------------------------------- */
  /* Volume / output                                                   */
  /* ---------------------------------------------------------------- */

  DI.renderAudio = (audio) => {
    if (!audio) return;
    const volume = state.bridge.volume;
    const level = Math.round((Number(volume.level) || 0) * 100);
    const muted = Boolean(volume.muted);

    const slider = $("#volume");
    if (slider && !state.draggingVolume) {
      slider.value = String(level);
      DI.setRangeFill(slider);
    }
    $("#volumeLabel").textContent = muted ? "MUT" : `${level}`;
    DI.setIcon($("#volumeIcon"), muted ? "volume-off" : "volume");
    $("#muteBtn").classList.toggle("is-muted", muted);

    const outputName = audio.output || "No output device";
    $("#volumeHudName").textContent = outputName;
    $("#sysOutputSelect").title = outputName;
    $("#outputSelect").title = outputName;

    const options = Array.isArray(audio.outputs) ? audio.outputs : [];
    populateOutputs($("#outputSelect"), options, audio.outputId);
    populateOutputs($("#sysOutputSelect"), options, audio.outputId);
    $("#audioChip").textContent = options.length ? `${options.length} DEVICES` : "NO AUDIO";

    const mic = audio.microphone || {};
    const micMuted = Boolean(mic.muted);
    $("#sysMicName").textContent = mic.name || "Microphone";
    $("#sysMicState").textContent = mic.available === false
      ? "Service offline"
      : micMuted
        ? "Muted system-wide"
        : "Live · capture allowed";
    $("#sysMicBtn").classList.toggle("is-muted", micMuted);
    $("#sysMicBtn").querySelector("span").textContent = micMuted ? "UNMUTE" : "MUTE";
    $("#micIconWrap").classList.toggle("is-muted", micMuted);
    DI.setIcon($("#sysMicIcon"), micMuted ? "mic-off" : "mic");
  };

  function populateOutputs(select, outputs, activeId) {
    if (!select) return;
    const signature = outputs.map((item) => item.id).join("|") + `#${activeId}`;
    if (select.dataset.signature === signature) return;
    select.dataset.signature = signature;
    select.textContent = "";
    if (!outputs.length) {
      const option = document.createElement("option");
      option.textContent = "No output devices";
      option.value = "";
      select.append(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const device of outputs) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.name;
      select.append(option);
    }
    if (activeId && outputs.some((item) => item.id === activeId)) select.value = activeId;
  }

  /* ---------------------------------------------------------------- */
  /* Lyrics                                                            */
  /* ---------------------------------------------------------------- */

  async function loadLyrics(media, key) {
    state.lyrics = { synced: [], plain: "", matched: null, source: "", trackKey: key, status: "loading" };
    state.activeLyric = -1;
    renderLyrics();
    const request = {
      title: media.title,
      artist: media.artist,
      album: media.album,
      duration: media.duration,
    };
    try {
      const result = await DI.api.getLyrics(request);
      if (state.lyrics.trackKey !== key) return;
      const synced = Array.isArray(result?.synced) ? result.synced : [];
      const plain = String(result?.plain || "");
      state.lyrics = {
        synced,
        plain,
        matched: result?.matched || null,
        source: result?.source || "LRCLIB",
        trackKey: key,
        status: synced.length || plain ? "ready" : "empty",
      };
      $("#lyricsBadge").textContent = synced.length ? "SYNCED" : plain ? "PLAIN" : "LRCLIB";
    } catch {
      if (state.lyrics.trackKey !== key) return;
      state.lyrics.status = "error";
      $("#lyricsBadge").textContent = "OFFLINE";
    }
    renderLyrics();
    highlightLyric(DI.positionNow());
  }

  function renderLyrics() {
    const list = $("#lyricsList");
    if (!list) return;
    const lyrics = state.lyrics;
    const media = state.bridge.media;

    if (!media?.active) {
      list.innerHTML = `<p class="lyrics-empty">Play a track to pull synced lyrics.</p>`;
      $("#lyricsBadge").textContent = "LRCLIB";
      return;
    }
    if (lyrics.status === "loading") {
      list.innerHTML = `<p class="lyrics-empty">Searching LRCLIB for “${DI.escapeHtml(DI.shortName(media.title, 38))}”…</p>`;
      return;
    }
    if (lyrics.status === "empty") {
      list.innerHTML = `<p class="lyrics-empty">No lyrics found for this track.</p>`;
      $("#lyricsBadge").textContent = "NO MATCH";
      return;
    }
    if (lyrics.status === "error") {
      list.innerHTML = `<p class="lyrics-empty">Lyrics service unavailable. Check your connection.</p>`;
      return;
    }

    if (lyrics.synced.length) {
      list.innerHTML = lyrics.synced
        .map(
          (line, index) =>
            `<p class="lyric-line" data-index="${index}" data-time="${line.time}">${DI.escapeHtml(line.text)}</p>`
        )
        .join("");
    } else if (lyrics.plain) {
      list.innerHTML = lyrics.plain
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 80)
        .map((line) => `<p class="lyric-line is-past">${DI.escapeHtml(line.trim())}</p>`)
        .join("");
    }
    list.scrollTop = 0;
    state.activeLyric = -1;
  }

  function highlightLyric(position) {
    const lyrics = state.lyrics;
    if (!lyrics.synced.length) return;
    const list = $("#lyricsList");
    if (!list) return;
    let activeIndex = -1;
    for (let i = 0; i < lyrics.synced.length; i += 1) {
      if (lyrics.synced[i].time <= position + 0.15) activeIndex = i;
      else break;
    }
    if (activeIndex === state.activeLyric) return;
    state.activeLyric = activeIndex;

    const lines = $$(".lyric-line", list);
    lines.forEach((line, index) => {
      line.classList.toggle("is-active", index === activeIndex);
      line.classList.toggle("is-past", index < activeIndex);
    });
    const active = lines[activeIndex];
    if (active && !lyricScrolling) {
      const target = active.offsetTop - list.clientHeight * 0.42;
      list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Bind                                                              */
  /* ---------------------------------------------------------------- */

  function seekToInput() {
    const seek = $("#seek");
    if (!seek) return false;
    const media = state.bridge.media;
    if (!media?.active || media.canSeek === false) return false;
    const seconds = Number(seek.value) / 10;
    DI.anchorMedia(seconds, Boolean(media.playing), state.mediaAnchor.trackKey, state.mediaAnchor.duration);
    $("#elapsed").textContent = DI.fmtTime(seconds);
    DI.setRangeFill(seek);
    DI.api.seek(seconds);
    return true;
  }

  function initMedia() {
    initArtworkLoad();
    $("#playBtn")?.addEventListener("click", () => DI.api.mediaCommand("toggle"));
    $("#prevBtn")?.addEventListener("click", () => DI.api.mediaCommand("previous"));
    $("#nextBtn")?.addEventListener("click", () => DI.api.mediaCommand("next"));

    const seek = $("#seek");
    seek?.addEventListener("pointerdown", () => {
      seekDragging = true;
      state.draggingSeek = true;
    });
    seek?.addEventListener("input", () => {
      DI.setRangeFill(seek);
      $("#elapsed").textContent = DI.fmtTime(Number(seek.value) / 10);
    });
    seek?.addEventListener("change", () => {
      seekToInput();
      seekDragging = false;
      state.draggingSeek = false;
    });
    seek?.addEventListener("pointerup", () => {
      setTimeout(() => {
        seekDragging = false;
        state.draggingSeek = false;
      }, 80);
    });

    const volume = $("#volume");
    volume?.addEventListener("pointerdown", () => {
      state.draggingVolume = true;
    });
    volume?.addEventListener("input", () => {
      state.draggingVolume = true;
      const level = Number(volume.value) / 100;
      DI.setRangeFill(volume);
      $("#volumeLabel").textContent = String(Math.round(level * 100));
      state.bridge.volume.level = level;
      state.bridge.volume.muted = false;
      DI.api.setVolume(level);
    });
    volume?.addEventListener("change", () => {
      state.volumeGuardUntil = Date.now() + 1200;
      state.draggingVolume = false;
      DI.api.setVolume(Number(volume.value) / 100);
    });
    volume?.addEventListener("pointerup", () => {
      state.volumeGuardUntil = Date.now() + 1200;
      setTimeout(() => {
        state.draggingVolume = false;
      }, 120);
    });

    $("#muteBtn")?.addEventListener("click", () => {
      DI.api.setMuted(!state.bridge.volume.muted);
    });

    $("#outputSelect")?.addEventListener("change", (event) => {
      DI.api.setOutputDevice(event.target.value);
    });
    $("#sysOutputSelect")?.addEventListener("change", (event) => {
      DI.api.setOutputDevice(event.target.value);
    });

    $("#lyricsList")?.addEventListener("click", (event) => {
      const line = event.target.closest(".lyric-line[data-time]");
      if (!line) return;
      const media = state.bridge.media;
      if (!media?.active || media.canSeek === false) return;
      const seconds = Number(line.dataset.time);
      DI.anchorMedia(seconds, Boolean(media.playing), state.mediaAnchor.trackKey, state.mediaAnchor.duration);
      DI.api.seek(seconds);
      $("#elapsed").textContent = DI.fmtTime(seconds);
      highlightLyric(seconds);
    });

    DI.redrawHooks.push(() => DI.startWave());
  }

  DI.inits.push(initMedia);

  DI.renderLyrics = renderLyrics;
  DI.loadLyrics = loadLyrics;
})();
