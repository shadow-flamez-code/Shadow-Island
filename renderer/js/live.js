"use strict";

/* Pulse page: activity stream, privacy/focus/mic controls, live demos. */
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

  const demoIntervals = new Map();

  function activityIcon(icon) {
    return ACTIVITY_ICONS[icon] || "activity";
  }

  DI.renderActivities = () => {
    const list = $("#activityList");
    if (!list) return;
    const activities = state.activities;
    list.textContent = "";

    if (!activities.length) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.innerHTML = 'No background tasks. Try a demo, or POST to <code>/activity</code>.';
      list.append(empty);
      DI.updateSessionCounts?.();
      return;
    }

    for (const activity of activities) {
      const row = document.createElement("div");
      const done = activity.status === "done";
      row.className = `activity-row${done ? " is-done" : ""}`;
      if (/^#[0-9a-f]{6}$/i.test(activity.accent || "")) {
        row.style.setProperty("--accent", activity.accent);
      }
      row.innerHTML = `
        <span class="activity-icon"></span>
        <span class="activity-main">
          <span class="activity-top"><b></b><small></small></span>
          <span class="activity-sub"></span>
          ${activity.progress !== null && activity.progress !== undefined ? '<span class="activity-bar"><i></i></span>' : ""}
          ${Array.isArray(activity.steps) && activity.steps.length ? '<span class="activity-steps"></span>' : ""}
        </span>
        <button class="activity-remove" type="button" title="Dismiss">${DI.icon("close")}</button>`;
      row.querySelector(".activity-icon").innerHTML = DI.icon(activityIcon(activity.icon));
      const iconWrap = row.querySelector(".activity-icon");
      iconWrap.className = "activity-icon";
      if (activity.status !== "done") {
        iconWrap.classList.add("is-glow");
        const ring = document.createElement("span");
        ring.className = `pulse-ring ${activity.accent ? "" : "cyan"}`;
        iconWrap.insertBefore(ring, iconWrap.firstChild);
      }
      if (done) iconWrap.style.opacity = "0.5";
      row.querySelector(".activity-top b").textContent = activity.title;
      const small = row.querySelector(".activity-top small");
      small.textContent = done
        ? "DONE"
        : activity.eta || (Number.isFinite(Number(activity.progress)) ? `${Math.round(activity.progress)}%` : "");
      row.querySelector(".activity-sub").textContent = activity.subtitle || "";
      const bar = row.querySelector(".activity-bar i");
      if (bar) bar.style.width = `${DI.clamp(Number(activity.progress) || 0, 0, 100)}%`;
      const steps = row.querySelector(".activity-steps");
      if (steps) {
        for (const step of activity.steps) {
          const span = document.createElement("span");
          span.textContent = step;
          steps.append(span);
        }
      }
      row.querySelector(".activity-remove").addEventListener("click", (event) => {
        event.stopPropagation();
        const interval = demoIntervals.get(activity.id);
        if (interval) {
          clearInterval(interval);
          demoIntervals.delete(activity.id);
        }
        DI.api.removeActivity(activity.id);
      });
      list.append(row);
    }
    DI.updateSessionCounts?.();
    DI.updatePill?.();
  };

  /* ---------------------------------------------------------------- */
  /* Focus + mic                                                       */
  /* ---------------------------------------------------------------- */

  DI.renderFocus = () => {
    const on = state.focus;
    const tile = $("#focusToggle");
    tile?.classList.toggle("is-on", on);
    const stateLabel = $("#focusState");
    if (stateLabel) stateLabel.textContent = on ? "On · popups paused" : "Off · popups allowed";
    const quick = $("#focusQuick");
    quick?.classList.toggle("is-active", on);
    const foot = $("#footFocus");
    if (foot) {
      foot.classList.toggle("is-on", on);
      foot.innerHTML = `<i></i> FOCUS ${on ? "ON" : "OFF"}`;
    }
    const footer = $("#focusFooterState");
    if (footer) footer.textContent = on ? "FOCUS ON" : "MONITORING";
  };

  DI.renderMic = (microphone) => {
    if (!microphone) return;
    const muted = Boolean(microphone.muted);
    const tile = $("#micToggle");
    tile?.classList.toggle("is-on", muted);
    tile?.classList.toggle("is-mic", true);
    const label = $("#micState");
    if (label) label.textContent = muted ? `Muted · ${microphone.name || "microphone"}` : "Live · system default";
    DI.setIcon($("#micToggleIcon"), muted ? "mic-off" : "mic");
  };

  /* ---------------------------------------------------------------- */
  /* Demo activities                                                   */
  /* ---------------------------------------------------------------- */

  function startDemo(kind) {
    const id = kind === "route" ? "demo-route-live" : "demo-transfer-live";
    const existing = demoIntervals.get(id);
    if (existing) clearInterval(existing);
    demoIntervals.delete(id);

    const config =
      kind === "route"
        ? {
            title: "Route · Office → Home",
            subtitle: "14 min · 7.1 km · via Riverside Ave",
            icon: "nav",
            accent: "#4ade80",
            steps: ["Leaving office", "Riverside Ave", "Home"],
          }
        : {
            title: "Transferring · Cyberpunk update",
            subtitle: "Steam · 0 GB of 28.7 GB",
            icon: "download",
            accent: "#22d3ee",
            steps: ["Downloading", "Verifying", "Installing"],
          };

    let progress = 4;
    const update = () => {
      const activity = state.activities.find((item) => item.id === id);
      if (!activity && progress > 4) {
        clearInterval(interval);
        demoIntervals.delete(id);
        return;
      }
      const done = progress >= 100;
      DI.api.addActivity({
        id,
        title: config.title,
        subtitle:
          kind === "route"
            ? progress >= 100
              ? "Arrived · 7.1 km"
              : `${Math.max(1, Math.round(14 - (progress / 100) * 14))} min · ${(7.1 * progress) / 100} km`
            : `Steam · ${((28.7 * progress) / 100).toFixed(1)} GB of 28.7 GB`,
        progress,
        status: done ? "done" : "active",
        icon: config.icon,
        accent: config.accent,
        eta: done ? "" : kind === "route" ? `${Math.max(1, Math.round(14 - (progress / 100) * 14))} min` : `${Math.max(1, Math.round((100 - progress) / 8))} min`,
        steps: config.steps,
      });
      if (done) {
        clearInterval(interval);
        demoIntervals.delete(id);
        DI.notify({
          app: kind === "route" ? "Maps" : "Transfers",
          title: kind === "route" ? "You have arrived" : "Transfer complete",
          body: kind === "route" ? "Office → Home · 7.1 km" : "Cyberpunk update installed.",
          tone: "success",
          duration: 5200,
        });
      }
      progress = Math.min(100, progress + 6 + Math.random() * 5);
    };

    update();
    const interval = setInterval(update, 1300);
    demoIntervals.set(id, interval);
  }

  function initLive() {
    $("#focusToggle")?.addEventListener("click", () => DI.api.setFocus(!state.focus));
    $("#footFocus")?.addEventListener("click", () => DI.api.setFocus(!state.focus));
    $("#micToggle")?.addEventListener("click", () => DI.api.toggleMic());

    $("#demoTransfer")?.addEventListener("click", () => startDemo("transfer"));
    $("#demoNav")?.addEventListener("click", () => startDemo("route"));
  }

  DI.inits.push(initLive);

  // Seed a live-ish state for screenshots / browser preview.
  if (DI.isPreview) {
    setTimeout(() => {
      if (!state.activities.length) return;
      DI.renderActivities();
    }, 500);
  }
})();
