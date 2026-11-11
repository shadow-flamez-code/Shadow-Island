"use strict";

/* Compact pill modes: idle clock, media, activity, timer + progress ring. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const state = DI.state;

  const ACTIVITY_ICONS = {
    nav: "nav",
    download: "download",
    render: "render",
    food: "food",
    ride: "ride",
    flight: "plane",
    sports: "trophy",
    sync: "sync",
    timer: "timer",
    generic: "activity",
  };

  let lastSignature = "";
  let lastMode = "";

  function activeTimer() {
    const timer = state.timer;
    if (!timer) return null;
    if (timer.mode === "pomodoro") {
      if (timer.running || timer.remaining < timer.total - 0.5) return timer;
      return null;
    }
    if (timer.running || timer.elapsed > 0) return timer;
    return null;
  }

  function activeActivity() {
    return state.activities.find((item) => item.status !== "done") || null;
  }

  function privacyHint() {
    const privacy = state.bridge.system?.privacy;
    if (!privacy) return "";
    if (privacy.webcam?.active) return "CAMERA ACTIVE";
    if (state.bridge.audio.microphone?.muted) return "MIC MUTED";
    if (privacy.microphone?.active) return "MIC IN USE";
    if (privacy.location?.active) return "LOCATION ACTIVE";
    return "";
  }
  DI.privacyHint = privacyHint;

  function mediaPercent(media) {
    const duration = Number(media.duration) || 0;
    if (!duration) return null;
    return DI.clamp((DI.positionNow() / duration) * 100, 0, 100);
  }

  function updateIdle(now) {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    setClockText(`${hh}:${mm}`);
    const compact = $("#compact");
    if (compact) {
      // The aurora drifts faster when the system is loud.
      const level = Number(state.bridge.volume?.level) || 0;
      const speed = Math.max(7, 17 - level * 8).toFixed(1);
      compact.style.setProperty("--aurora-speed", `${speed}s`);
      compact.style.setProperty("--aurora-speed-b", `${(Number(speed) + 3).toFixed(1)}s`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rolling clock                                                     */
  /* ---------------------------------------------------------------- */

  const DIGIT_STRIP = "0123456789";
  let clockSlots = null;

  function buildClock() {
    const host = $("#compactIdleTime");
    if (!host || clockSlots) return;
    host.textContent = "";
    const makeDigit = () => {
      const slot = document.createElement("span");
      slot.className = "clk-digit";
      const strip = document.createElement("span");
      strip.className = "clk-strip";
      for (const character of DIGIT_STRIP) {
        const item = document.createElement("i");
        item.textContent = character;
        strip.appendChild(item);
      }
      slot.appendChild(strip);
      host.appendChild(slot);
      return strip;
    };
    const h1 = makeDigit();
    const h2 = makeDigit();
    const colon = document.createElement("span");
    colon.className = "clk-colon";
    colon.innerHTML = "<i></i><i></i>";
    host.appendChild(colon);
    const m1 = makeDigit();
    const m2 = makeDigit();
    clockSlots = [h1, h2, colon, m1, m2];
  }

  function setClockText(value) {
    buildClock();
    if (!clockSlots) return;
    const host = $("#compactIdleTime");
    if (host) host.setAttribute("aria-label", `Time ${value}`);
    const digits = value.replace(":", "");
    const strips = [clockSlots[0], clockSlots[1], clockSlots[3], clockSlots[4]];
    strips.forEach((strip, index) => {
      if (!strip) return;
      const digit = Number(digits[index]) || 0;
      const previous = Number(strip.dataset.digit ?? digit);
      strip.dataset.digit = String(digit);
      if (Math.abs(digit - previous) > 2) {
        // Big jump (hour rollover): snap instead of spinning the whole strip.
        strip.style.transition = "none";
        strip.style.transform = `translateY(${-digit * 10}%)`;
        void strip.offsetWidth;
        strip.style.transition = "";
        return;
      }
      strip.style.transform = `translateY(${-digit * 10}%)`;
    });
  }

  /* Maps a percentage of the track onto the *perimeter* of the capsule, so
     the progress sweeps at a constant speed instead of crawling along the
     long edges and racing around the caps. The table is the conic angle of
     every point on the capsule outline, sampled once per size. */
  let angleTable = { key: "", values: [] };

  function buildAngleTable(width, height) {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (angleTable.key === key) return angleTable.values;
    const radius = height / 2;
    const straight = Math.max(0, (width - height) / 2);
    const arc = Math.PI * radius;
    const steps = 240;
    const values = new Array(steps + 1);
    for (let index = 0; index <= steps; index += 1) {
      // Walk the capsule clockwise, starting at the top centre.
      const s = (index / steps) * (3 * straight + 2 * arc);
      let x = 0;
      let y = 0;
      if (s <= straight) {
        x = s;
        y = -radius;
      } else if (s <= straight + arc) {
        const phi = (s - straight) / radius;
        x = straight + radius * Math.sin(phi);
        y = -radius * Math.cos(phi);
      } else if (s <= straight + arc + 2 * straight) {
        x = straight - (s - straight - arc);
        y = radius;
      } else if (s <= 2 * straight + 2 * arc) {
        const phi = (s - straight - arc - 2 * straight) / radius;
        x = -straight - radius * Math.sin(phi);
        y = radius * Math.cos(phi);
      } else {
        x = -straight + (s - 2 * straight - 2 * arc);
        y = -radius;
      }
      values[index] = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    }
    angleTable = { key, values };
    return values;
  }

  function progressAngle(percent) {
    const compact = $("#compact");
    const width = (compact?.offsetWidth || 256) + 4;
    const height = (compact?.offsetHeight || 42) + 4;
    const values = buildAngleTable(width, height);
    const position = (DI.clamp(Number(percent) || 0, 0, 100) / 100) * (values.length - 1);
    const low = Math.floor(position);
    const high = Math.min(values.length - 1, low + 1);
    const mix = position - low;
    return values[low] + (values[high] - values[low]) * mix;
  }

  function setRing(mode, percent, color) {
    const compact = $("#compact");
    if (!compact) return;
    if (state.settings?.progressRing === false) {
      compact.dataset.progress = "none";
      return;
    }
    const showRing = percent !== null && Number.isFinite(percent);
    compact.dataset.progress = showRing ? mode : "none";
    if (color) compact.style.setProperty("--pill-ring", color);
    if (showRing) {
      compact.style.setProperty("--pill-progress", String(DI.clamp(percent, 0, 100)));
      compact.style.setProperty("--pill-progress-angle", `${progressAngle(percent).toFixed(2)}deg`);
    }
  }

  function updatePill() {
    const compact = $("#compact");
    if (!compact) return;
    const now = new Date();
    const activity = activeActivity();
    const timer = activeTimer();
    const media = state.bridge.media;

    let mode = "idle";
    let percent = null;
    let color = "#22d3ee";
    let signature = "";

    if (activity) {
      // Live activities (transfers, downloads, routes) take over the pill,
      // then a running timer, then the current media session.
      mode = "activity";
      const hasProgress = Number.isFinite(Number(activity.progress)) && activity.progress !== null;
      percent = hasProgress ? DI.clamp(Number(activity.progress), 0, 100) : null;
      color = /^#[0-9a-f]{6}$/i.test(activity.accent || "") ? activity.accent : "#a855f7";
      $("#compactAltIconWrap").style.setProperty("--alt-color", color);
      DI.setIcon($("#compactAltIcon"), ACTIVITY_ICONS[activity.icon] || "activity");
      $("#compactAltTitle").textContent = DI.shortName(activity.title, 34);
      $("#compactAltSub").textContent = activity.eta
        ? activity.eta
        : hasProgress
          ? `${Math.round(Number(activity.progress))}% · ${activity.subtitle || "Background task"}`
          : activity.subtitle || "Background activity";
      signature = `activity|${activity.id}|${percent}|${activity.eta}`;
    } else if (timer) {
      mode = "timer";
      color = timer.mode === "stopwatch" ? "#4ade80" : "#22d3ee";
      $("#compactAltIconWrap").style.setProperty("--alt-color", color);
      DI.setIcon($("#compactAltIcon"), timer.mode === "stopwatch" ? "stopwatch" : "timer");
      if (timer.mode === "stopwatch") {
        percent = ((timer.elapsed % 60) / 60) * 100;
        $("#compactAltTitle").textContent = DI.fmtClock(timer.elapsed);
        $("#compactAltSub").textContent = timer.running ? "Stopwatch · running" : "Stopwatch · paused";
      } else {
        percent = timer.total ? (timer.remaining / timer.total) * 100 : null;
        $("#compactAltTitle").textContent = DI.fmtClock(timer.remaining);
        $("#compactAltSub").textContent = timer.running ? "Focus timer · running" : "Focus timer · paused";
      }
      signature = `timer|${timer.mode}|${Math.round(timer.remaining)}|${Math.round(timer.elapsed)}`;
    } else if (media?.active) {
      mode = "media";
      percent = mediaPercent(media);
      const accent = document.documentElement.style.getPropertyValue("--accent").trim();
      color = media.playing ? (accent || "#22d3ee") : "#7c3aed";
      signature = `media|${media.trackKey}|${percent}|${media.playing}`;
    } else {
      signature = `idle|${now.getHours()}|${now.getMinutes()}`;
    }

    if (mode === "idle") {
      updateIdle(now);
    }

    compact.dataset.mode = mode;
    if (mode !== lastMode) {
      lastMode = mode;
      // Faces morph into each other instead of popping.
      compact.classList.remove("face-swap");
      void compact.offsetWidth;
      compact.classList.add("face-swap");
      DI.reportWindowBox?.();
    }
    // The capsule rim breathes with the audio level.
    setRing(mode, percent, color);

    if (signature === lastSignature) return;
    lastSignature = signature;
  }

  DI.updatePill = updatePill;
  DI.setClockText = setClockText;

  function initPill() {
    buildClock();
    updatePill();
  }

  DI.inits.push(initPill);
})();
