"use strict";

/* Core page: telemetry gauges, charts, battery, privacy and connections. */
(() => {
  const DI = window.DI;
  const $ = DI.$;
  const $$ = DI.$$;
  const state = DI.state;

  const GB = 1024 * 1024 * 1024;
  const PRIVACY_LABELS = { webcam: "Camera", microphone: "Microphone", location: "Location" };
  const GAUGE_LENGTH = 314.16;
  const lastPrivacyNotify = {};

  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  // Per-group refresh cadence (ms). Gauges/rates move every second,
  // charts every two, and slow subsystems every five — this stops the flicker.
  // -Infinity means the very first stats tick renders every group.
  const REFRESH_MS = { fast: 1000, chart: 2000, slow: 5000 };
  const groupLast = { fast: -Infinity, chart: -Infinity, slow: -Infinity };

  function setGauge(ringId, value, readoutId, text) {
    const ring = $(ringId);
    const percent = DI.clamp(value, 0, 100);
    if (ring && ring._lastPercent !== percent) {
      ring._lastPercent = percent;
      ring.style.setProperty("--value", percent.toFixed(1));
      const fill = ring.querySelector(".gauge-fill");
      if (fill) fill.style.strokeDashoffset = String(GAUGE_LENGTH * (1 - percent / 100));
    }
    if (readoutId) {
      const readout = $(readoutId);
      if (readout && readout._lastText !== text) {
        const old = Number(readout.textContent.replace("%", "").replace(/[^0-9.-]/g, "")) || 0;
        const newVal = Math.round(percent);
        readout._lastText = text;
        if (Math.abs(newVal - old) > 0.5) {
          readout.classList.remove("count-up");
          void readout.offsetWidth;
          readout.classList.add("count-up");
        }
        readout.textContent = text;
      }
    }
  }

  function setMiniRing(ringId, value, readoutId, text) {
    const ring = $(ringId);
    if (ring && ring._lastPercent !== value) {
      ring._lastPercent = value;
      ring.style.setProperty("--value", DI.clamp(value, 0, 100).toFixed(1));
    }
    const readout = $(readoutId);
    if (readout && readout._lastText !== text) {
      readout._lastText = text;
      readout.textContent = text;
    }
  }

  function pushHistory(key, value, limit = 60) {
    const list = state.history[key];
    list.push(value);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  // History is recorded every fast tick (1s); the canvases redraw on
  // the slower chart cadence (2s).
  function recordHistory(stats) {
    pushHistory("cpu", num(stats.cpu));
    pushHistory("ram", num(stats.memory));
    pushHistory("gpu", num(stats.gpu?.usage));
    pushHistory("netUp", num(stats.network?.up));
    pushHistory("netDown", num(stats.network?.down));
    pushHistory("battery", stats.battery?.available ? num(stats.battery.percent) : 100);
  }

  function drawCharts() {
    DI.drawSpark($("#ramSpark"), state.history.ram, DI.colors.cyan, { min: 0, max: 100 });
    DI.drawSpark($("#gpuSpark"), state.history.gpu, DI.colors.pink, { min: 0, max: 100 });
    DI.drawSpark($("#powerSpark"), state.history.battery, state.bridge.system?.battery?.available ? DI.colors.green : DI.colors.cyan, {
      min: 0,
      max: 100,
    });
    drawNetChart();
  }

  function drawNetChart() {
    const canvas = $("#netChart");
    if (!canvas) return;
    const baked = DI.dprCanvas(canvas);
    if (!baked) return;
    const { ctx, width, height } = baked;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i += 1) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const down = state.history.netDown;
    const up = state.history.netUp;
    const max = Math.max(1024, ...down, ...up) * 1.18;
    if (down.length < 2) return;

    const plot = (values, color, fillAlpha) => {
      const points = values.map((value, index) => [
        (index / (values.length - 1)) * width,
        height - 2 - (value / max) * (height - 8),
      ]);
      const trace = () => {
        ctx.beginPath();
        points.forEach(([x, y], index) => {
          if (index === 0) {
            ctx.moveTo(x, y);
            return;
          }
          const [px, py] = points[index - 1];
          const mx = (px + x) / 2;
          ctx.bezierCurveTo(mx, py, mx, y, x, y);
        });
      };
      trace();
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${color}${fillAlpha}`);
      gradient.addColorStop(1, `${color}00`);
      ctx.fillStyle = gradient;
      ctx.fill();
      trace();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    plot(up, "#4ade80", "30");
    plot(down, "#22d3ee", "3d");
  }

  function renderNetwork(stats) {
    const network = stats.network || {};
    const up = DI.rateParts(network.up);
    const down = DI.rateParts(network.down);

    const setText = (selector, value) => {
      const node = $(selector);
      if (node) node.textContent = value;
    };
    setText("#netUp", up.value);
    $("#netUp")?.nextElementSibling && ($("#netUp").nextElementSibling.textContent = up.unit);
    setText("#netDown", down.value);
    $("#netDown")?.nextElementSibling && ($("#netDown").nextElementSibling.textContent = down.unit);
    setText("#netName", network.ssid || network.type || "Offline");
    setText("#netUpBig", up.value);
    setText("#netDownBig", down.value);
    $("#netUpBig")?.parentElement?.querySelector("small") && ($("#netUpBig").parentElement.querySelector("small").textContent = up.unit);
    $("#netDownBig")?.parentElement?.querySelector("small") && ($("#netDownBig").parentElement.querySelector("small").textContent = down.unit);
    setText("#netSsid", network.ssid || network.type || "No network");
    setText("#netTypeChip", (network.type || "offline").toUpperCase());
    setText("#railNet", network.type === "Wi-Fi" && network.ssid ? network.ssid : network.type || "Offline");
  }

  function renderBattery(stats) {
    const battery = stats.battery || {};
    const available = Boolean(battery.available) && Number.isFinite(Number(battery.percent));
    const percent = available ? DI.clamp(Math.round(battery.percent), 0, 100) : 100;
    const plugged = Boolean(battery.plugged);
    const low = available && percent <= 20 && !plugged;

    const setText = (selector, value) => {
      const node = $(selector);
      if (node) node.textContent = value;
    };
    const fill = $("#batteryFill");
    if (fill) fill.style.width = `${percent}%`;
    setText("#batteryPct", available ? `${percent}` : "AC");
    setText("#batteryState", available
      ? plugged
        ? "Charging"
        : "On battery"
      : "Desktop power");
    setText("#powerHint", available
      ? battery.secondsLeft
        ? `${DI.fmtTime(battery.secondsLeft)} ${plugged ? "to full" : "remaining"}`
        : plugged
          ? "AC connected"
          : "Estimating…"
      : "AC online");

    const shell = $("#batteryFill")?.closest(".battery-shell");
    shell?.classList.toggle("is-low", low);

    const glyph = $("#batteryGlyph");
    if (glyph) {
      glyph.classList.toggle("is-low", low);
      glyph.classList.toggle("is-charging", available && plugged);
    }
    const sysFill = $("#sysBatteryFill");
    if (sysFill) sysFill.style.width = available ? `${percent}%` : "100%";
    setText("#sysBatteryPct", available ? `${percent}` : "AC");
    const sysPctNext = $("#sysBatteryPct")?.nextElementSibling;
    if (sysPctNext) sysPctNext.style.display = available ? "" : "none";
    setText("#sysBatteryState", available
      ? plugged
        ? "Charging · AC connected"
        : "Discharging"
      : "No battery detected");
    setText("#sysBatteryTime", available
      ? battery.secondsLeft
        ? `${DI.fmtTime(battery.secondsLeft)} ${plugged ? "until full" : "estimated"}`
        : "Estimating remaining time"
      : "Running on wall power");

    setText("#powerMode", DI.shortName(stats.powerMode || "Balanced", 20));
    setText("#sysPowerMode", DI.shortName(stats.powerMode || "Balanced", 22));
    setText("#railBattery", available ? `${percent}%` : "AC");
  }

  function renderPrivacy(privacy) {
    if (!privacy) return;
    const entries = Object.keys(PRIVACY_LABELS);
    let anyActive = false;

    for (const key of entries) {
      const info = privacy[key] || {};
      const active = Boolean(info.active);
      anyActive ||= active;

      $$(`[data-privacy="${key}"]`).forEach((node) => {
        node.classList.toggle("is-active", active);
        if (node.classList.contains("privacy-chip")) {
          node.title = active ? `${PRIVACY_LABELS[key]} in use${info.app ? ` · ${info.app}` : ""}` : `${PRIVACY_LABELS[key]} idle`;
        }
      });
      $$(`.privacy-row[data-privacy="${key}"] [data-status]`).forEach((node) => {
        node.textContent = active
          ? info.count > 1
            ? `${info.app || "In use"} · ${info.count} apps`
            : info.app || "In use"
          : "Idle";
      });

      if (state.privacySeen) {
        const previous = Boolean(state.privacyLast[key]);
        const last = lastPrivacyNotify[key] || 0;
        if (active && !previous && Date.now() - last > 20000) {
          lastPrivacyNotify[key] = Date.now();
          DI.notify({
            app: "Privacy",
            title: `${PRIVACY_LABELS[key]} is active`,
            body: info.app ? `${info.app} is using it right now.` : "An app is using it right now.",
            tone: "privacy",
            icon: key === "webcam" ? "camera" : key === "microphone" ? "mic" : "location",
            duration: 4600,
          });
        }
      }
      state.privacyLast[key] = active;
    }

    state.privacySeen = true;
    const chip = $("#privacyChip");
    if (chip) {
      chip.textContent = anyActive ? "IN USE" : "ALL CLEAR";
      chip.classList.toggle("is-alert", anyActive);
    }
  }

  function renderHello(biometrics) {
    if (!biometrics) return;
    state.biometrics = biometrics;
    if (state.hello.scanning) return;
    const card = $("#helloCard");
    const available = Boolean(biometrics.available);
    $("#helloStatus").textContent = available
      ? state.hello.verified
        ? "Service verified · face or PIN ready"
        : "Biometric service online"
      : "Windows Hello service unavailable";
    $("#helloAction").textContent = available ? (state.hello.verified ? "READY" : "CHECK") : "N/A";
    card?.classList.toggle("is-verified", available && state.hello.verified);
  }

  function renderConnections(stats) {
    const list = $("#connList");
    if (!list) return;
    const audio = state.bridge.audio;
    const network = stats.network || {};
    const rows = [];

    rows.push({
      icon: "output",
      name: audio.output || "System default output",
      detail: "Audio out",
      ok: Boolean(audio.output),
    });
    rows.push({
      icon: audio.microphone?.muted ? "mic-off" : "mic",
      name: audio.microphone?.name || "Microphone",
      detail: audio.microphone?.muted ? "Muted" : "Live",
      ok: !audio.microphone?.muted && audio.microphone?.available !== false,
    });
    rows.push({
      icon: network.type === "Wi-Fi" ? "wifi" : "globe",
      name: network.ssid || network.type || "No network",
      detail: network.type || "Offline",
      ok: Boolean(network.type) && network.type !== "Disconnected",
    });

    const gamepad = [...(navigator.getGamepads?.() || [])].find((pad) => pad?.connected);
    if (gamepad) {
      rows.push({
        icon: "gamepad",
        name: DI.shortName(gamepad.id.replace(/\s*\(.*?\)\s*/g, " ").trim(), 28),
        detail: "Gamepad",
        ok: true,
      });
    }
    if (stats.biometrics) {
      rows.push({
        icon: "hello",
        name: "Windows Hello",
        detail: stats.biometrics.available ? "Online" : "Offline",
        ok: Boolean(stats.biometrics.available),
      });
    }
    rows.push({
      icon: "pulse",
      name: `${stats.processCount || 0} processes`,
      detail: DI.shortName(stats.powerMode || "Balanced", 18),
      ok: true,
    });

    const signature = JSON.stringify(rows.map((row) => [row.icon, row.name, row.detail, row.ok]));
    if (signature !== state._connSig) {
      state._connSig = signature;
      list.textContent = "";
      for (const row of rows) {
        const node = document.createElement("div");
        node.className = "conn-row";
        node.innerHTML = `${DI.icon(row.icon)}<b></b><small${row.ok ? ' class="ok"' : ""}></small>`;
        node.querySelector("b").textContent = row.name;
        node.querySelector("small").textContent = row.detail;
        list.append(node);
      }
    }
  }

  const normalizeName = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  function renderBluetooth(stats) {
    const list = $("#btListFull");
    if (!list) return;
    const bluetooth = stats.bluetooth || {};
    const devices = Array.isArray(bluetooth.devices) ? bluetooth.devices : [];
    const outputs = state.bridge.audio.outputs || [];

    const findOutput = (device) => {
      const base = normalizeName(device.name);
      if (!base) return null;
      return (
        outputs.find((output) => {
          const name = normalizeName(output.name);
          return name.includes(base) || (base.length > 6 && name.startsWith(base.slice(0, 10)));
        }) || null
      );
    };

    const chip = $("#btChip");
    if (chip) {
      chip.textContent = bluetooth.powered
        ? `${devices.length} PAIRED`
        : bluetooth.available
          ? "UNAVAILABLE"
          : "OFF";
    }
    const radioStatus = $("#btRadioStatus");
    if (radioStatus) radioStatus.textContent = bluetooth.powered ? `Radio on · ${devices.length} paired` : "Radio off";
    const radioSub = $("#btRadioSub");
    if (radioSub) radioSub.textContent = devices.length ? DI.shortName(devices[0].name, 34) : "No paired devices found";

    const signature = JSON.stringify({
      powered: Boolean(bluetooth.powered),
      outputs: outputs.map((output) => output.id),
      active: state.bridge.audio.outputId,
      devices: devices.map((device) => [device.name, device.paired, device.audio, Boolean(findOutput(device))]),
    });
    if (signature === state._btSig) return;
    state._btSig = signature;

    list.textContent = "";
    if (!devices.length) {
      const empty = document.createElement("div");
      empty.className = "empty-note bt-empty";
      empty.textContent = bluetooth.available
        ? "No paired devices. Tap PAIR to add one."
        : "Bluetooth radio is off.";
      list.append(empty);
      return;
    }

    for (const device of devices.slice(0, 10)) {
      const output = findOutput(device);
      const isActiveOutput = Boolean(output && output.id === state.bridge.audio.outputId);
      const row = document.createElement("div");
      row.className = `conn-row bt-row${isActiveOutput ? " is-active" : ""}`;
      row.innerHTML = `${DI.icon("bluetooth")}<b></b><small></small>`;
      row.querySelector("b").textContent = DI.shortName(device.name, 30);
      const small = row.querySelector("small");
      const button = document.createElement("button");
      button.className = "bt-btn";
      button.type = "button";
      if (isActiveOutput) {
        small.textContent = "Active output";
        small.className = "ok";
        button.textContent = "ON";
        button.disabled = true;
      } else if (output) {
        small.textContent = "Audio";
        button.textContent = "USE";
        button.title = `Route output to ${device.name}`;
        button.addEventListener("click", () => DI.api.setOutputDevice(output.id));
      } else {
        small.textContent = device.paired ? "Paired" : "Not paired";
        small.className = device.paired ? "ok" : "";
        button.textContent = device.audio ? "CONNECT" : "PAIR";
        button.title = "Open Bluetooth settings to connect";
        button.addEventListener("click", () => DI.api.openBluetooth?.());
      }
      row.append(button);
      list.append(row);
    }
  }

  function renderWifiDetail(stats) {
    const detail = stats.wifiDetail || {};
    const network = stats.network || {};
    const ssidEl = $("#wifiSsidBig");
    if (!ssidEl) return;
    ssidEl.textContent = detail.ssid || network.ssid || "No network";
    const signal = Number.isFinite(Number(detail.signal)) && detail.signal !== null ? Math.round(Number(detail.signal)) : null;
    $("#wifiSignalPct").textContent = signal === null ? "--" : `${signal}%`;
    $("#wifiRate").textContent = detail.rate ? `${detail.rate} Mbps` : "--";
    $("#wifiChannel").textContent = detail.channel ? `${detail.channel}` : "--";
    const chip = $("#wifiAuthChip");
    if (chip) chip.textContent = DI.shortName(detail.auth || "OPEN", 18).toUpperCase();
    const bars = $("#wifiBars");
    if (bars) {
      const lit = signal === null ? 0 : DI.clamp(Math.ceil(signal / 20), 0, 5);
      [...bars.children].forEach((bar, index) => bar.classList.toggle("is-lit", index < lit));
    }
  }

  function renderCores(stats) {
    const wrap = $("#coreBars");
    if (!wrap) return;
    const usage = Array.isArray(stats.coresUsage) ? stats.coresUsage : [];
    if (wrap.childElementCount !== usage.length && usage.length) {
      wrap.textContent = "";
      for (let index = 0; index < usage.length; index += 1) {
        const bar = document.createElement("span");
        bar.className = "core-bar";
        bar.title = `Core ${index + 1}`;
        bar.append(document.createElement("i"));
        wrap.append(bar);
      }
    }
    [...wrap.children].forEach((bar, index) => {
      const value = DI.clamp(Number(usage[index]) || 0, 0, 100);
      bar.firstChild.style.height = `${Math.max(6, value)}%`;
      bar.classList.toggle("is-hot", value > 80);
      bar.title = `Core ${index + 1} · ${Math.round(value)}%`;
    });
    const top = Array.isArray(stats.topProcesses) ? stats.topProcesses : [];
    const label = $("#topProcs");
    if (label) label.textContent = top.length ? top.map((proc) => `${proc.name} ${proc.cpu}%`).join(" · ") : "All cores idle";
  }

  DI.renderStats = (stats) => {
    if (!stats) return;
    const now = performance.now();
    const dueFast = now - groupLast.fast >= REFRESH_MS.fast;
    const dueChart = now - groupLast.chart >= REFRESH_MS.chart;
    const dueSlow = now - groupLast.slow >= REFRESH_MS.slow;
    if (!dueFast && !dueChart && !dueSlow) return;

    const cpu = DI.clamp(num(stats.cpu), 0, 100);
    const memory = DI.clamp(num(stats.memory), 0, 100);
    const memoryUsed = num(stats.memoryUsed);
    const memoryTotal = num(stats.memoryTotal);
    const gpu = stats.gpu || {};
    const gpuAvailable = Boolean(gpu.available) && Number.isFinite(Number(gpu.usage));
    const gpuUsage = gpuAvailable ? DI.clamp(Number(gpu.usage), 0, 100) : 0;

    const setText = (selector, value) => {
      const node = $(selector);
      if (node && node._lastText !== value) {
        node._lastText = value;
        node.textContent = value;
      }
    };

    if (dueFast) {
      groupLast.fast = now;
      recordHistory(stats);
      setMiniRing("#cpuMiniRing", cpu, "#cpuMini", String(Math.round(cpu)));
      setMiniRing("#ramMiniRing", memory, "#ramMini", String(Math.round(memory)));
      setMiniRing("#gpuMiniRing", gpuUsage, "#gpuMini", gpuAvailable ? String(Math.round(gpuUsage)) : "--");

      setGauge("#gaugeCpu", cpu, "#cpuValue", String(Math.round(cpu)));
      setGauge("#gaugeRam", memory, "#ramValue", String(Math.round(memory)));
      setGauge("#gaugeGpu", gpuUsage, "#gpuValue", gpuAvailable ? String(Math.round(gpuUsage)) : "--");

      setText("#cpuCores", `${stats.cores || navigator.hardwareConcurrency || "--"} THREADS`);
      setText("#cpuLoad", `${stats.processCount || 0} processes`);
      setText("#cpuTemp", stats.cpuTemp ? Math.round(stats.cpuTemp) : "--");

      setText("#ramTotal", memoryTotal ? `${(memoryTotal / GB).toFixed(0)} GB` : "-- GB");
      setText("#ramUsed", memoryUsed ? (memoryUsed / GB).toFixed(1) : "--");
      setText("#ramTotalSide", memoryTotal ? (memoryTotal / GB).toFixed(0) : "--");

      setText("#gpuVendor", gpu.vendor || (gpu.available ? "GPU" : "UNAVAILABLE"));
      setText("#gpuName", DI.shortName(gpu.name || "No GPU sensor", 30));
      setText("#gpuTemp", Number.isFinite(Number(gpu.temperature)) ? Math.round(gpu.temperature) : "--");

      renderNetwork(stats);
      renderCores(stats);
    }

    if (dueChart) {
      groupLast.chart = now;
      if (state.panelOpen) drawCharts();
    }

    if (dueSlow) {
      groupLast.slow = now;
      renderBattery(stats);
      renderPrivacy(stats.privacy);
      renderHello(stats.biometrics);
      renderConnections(stats);
      renderBluetooth(stats);
      renderWifiDetail(stats);
      renderBrightness(stats);
      setText("#railUptime", DI.fmtUptime(stats.uptime));
    }
  };

  function scanHello() {
    if (state.hello.scanning) return;
    const biometrics = state.biometrics || state.bridge.system?.biometrics;
    const card = $("#helloCard");
    state.hello.scanning = true;
    card?.classList.add("is-scanning");
    card?.classList.remove("is-verified");
    $("#helloStatus").textContent = "Checking WbioSrvc…";
    $("#helloAction").textContent = "SCAN";
    setTimeout(() => {
      state.hello.scanning = false;
      state.hello.verified = Boolean(biometrics?.available);
      card?.classList.remove("is-scanning");
      renderHello(biometrics || { available: false });
      if (state.hello.verified) {
        DI.chime();
        DI.notify({
          app: "Security",
          title: "Windows Hello is ready",
          body: "Biometric service is online. Face or PIN unlocks at sign-in.",
          tone: "success",
          icon: "hello",
          duration: 4200,
        });
      } else {
        DI.notify({
          app: "Security",
          title: "Windows Hello unavailable",
          body: "The biometric service is not running on this PC.",
          tone: "error",
          icon: "hello",
          duration: 4200,
        });
      }
    }, 1500);
  }

  let draggingBrightness = false;

  function renderBrightness(stats) {
    const row = $("#brightnessRow");
    if (!row) return;
    const brightness = stats.brightness || {};
    const supported = Boolean(brightness.supported) && Number.isFinite(Number(brightness.level));
    row.hidden = !supported;
    if (!supported || draggingBrightness) return;
    const slider = $("#brightness");
    if (slider) {
      slider.value = String(Math.round(Number(brightness.level)));
      DI.setRangeFill(slider);
    }
    const label = $("#brightnessLabel");
    if (label) label.textContent = `${Math.round(Number(brightness.level))}`;
  }

  function initSystem() {
    $("#helloCard")?.addEventListener("click", scanHello);
    $("#btOpenSettings")?.addEventListener("click", () => DI.api.openBluetooth?.());
    $("#btPairBtn")?.addEventListener("click", () => DI.api.openBluetooth?.());
    $("#connBtBtn")?.addEventListener("click", () => DI.api.openBluetooth?.());
    $("#connNetBtn")?.addEventListener("click", () => DI.api.openNetwork?.());

    const brightness = $("#brightness");
    brightness?.addEventListener("pointerdown", () => {
      draggingBrightness = true;
    });
    brightness?.addEventListener("input", () => {
      draggingBrightness = true;
      DI.setRangeFill(brightness);
      const label = $("#brightnessLabel");
      if (label) label.textContent = brightness.value;
    });
    brightness?.addEventListener("change", () => {
      draggingBrightness = false;
      DI.api.setBrightness?.(Number(brightness.value));
    });
    window.addEventListener("gamepadconnected", () => {
      if (state.bridge.system) renderConnections(state.bridge.system);
    });
    window.addEventListener("gamepaddisconnected", () => {
      if (state.bridge.system) renderConnections(state.bridge.system);
    });
    DI.redrawHooks.push(() => {
      if (state.bridge.system) drawCharts();
    });
  }

  DI.inits.push(initSystem);
})();
