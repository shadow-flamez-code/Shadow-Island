"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

/**
 * Owns the Windows helper processes:
 *  - media bridge  (WinRT media sessions + artwork)
 *  - volume bridge (Core Audio via pycaw, mic + output switching)
 *  - system bridge (psutil telemetry, GPU, privacy, power)
 *
 * Keeping them separate is deliberate: the COM libraries they use interfere
 * with each other when loaded in the same process on Windows.
 */
const SERVICE_FILES = {
  media: { exe: "media-bridge.exe", script: "media_bridge.py" },
  volume: { exe: "volume-bridge.exe", script: "volume_bridge.py" },
  system: { exe: "system-bridge.exe", script: "system_bridge.py" },
};

class SystemBridge extends EventEmitter {
  constructor({ bridgeRoot, logger = console } = {}) {
    super();
    this.bridgeRoot = bridgeRoot;
    this.logger = logger;
    this.stopping = false;
    this.children = new Map();
    this.restartTimers = new Map();
    this.states = {
      media: null,
      volume: { level: 0, muted: false, available: false },
      audio: {
        output: "",
        outputId: "",
        outputs: [],
        microphone: { name: "Microphone", muted: false, available: false },
      },
      system: null,
    };
    this.online = { media: false, volume: false, system: false };
    this.errors = { media: null, volume: null, system: null };
    this.cachedTrackKey = null;
    this.cachedArtwork = null;
    this.nextCommandId = 1;
  }

  start() {
    this.startService("media");
    this.startService("volume");
    this.startService("system");
  }

  resolveService(service) {
    const files = SERVICE_FILES[service];
    if (!files) throw new Error(`Unknown bridge service: ${service}`);
    for (const candidate of [
      path.join(this.bridgeRoot, files.exe),
      path.join(this.bridgeRoot, "bin", files.exe),
    ]) {
      if (fs.existsSync(candidate)) {
        return { command: candidate, args: [], cwd: path.dirname(candidate) };
      }
    }
    const script = path.join(this.bridgeRoot, files.script);
    const python = process.env.ISLAND_PYTHON || "python";
    return { command: python, args: ["-u", script], cwd: this.bridgeRoot };
  }

  startService(service) {
    if (this.stopping) return;
    if (this.children.has(service)) return;

    const resolved = this.resolveService(service);
    let child;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: resolved.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
        },
      });
    } catch (error) {
      this.handleFailure(service, error);
      return;
    }

    this.children.set(service, child);
    this.online[service] = false;
    this.errors[service] = null;

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => this.handleLine(service, line));

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      if (process.env.ISLAND_DEBUG) {
        this.logger.error(`[${service}] ${chunk.toString().trimEnd()}`);
      }
    });

    child.on("error", (error) => {
      this.errors[service] = error.message;
      this.logger.error(`[${service}] failed to start: ${error.message}`);
      this.handleFailure(service, error);
    });

    child.on("exit", (code, signal) => {
      this.children.delete(service);
      const wasOnline = this.online[service];
      this.online[service] = false;
      if (!this.stopping) {
        if (stderrTail.trim()) {
          this.errors[service] = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ");
        }
        if (wasOnline || code !== 0) {
          this.logger.error(
            `[${service}] bridge stopped (code ${code}, signal ${signal || "none"})`
          );
        }
        this.emitState();
        this.scheduleRestart(service, wasOnline ? 1500 : 5000);
      }
    });

    this.emitState();
  }

  handleFailure(service, error) {
    this.online[service] = false;
    this.errors[service] = error?.message || String(error);
    this.children.delete(service);
    this.emitState();
    if (!this.stopping) this.scheduleRestart(service, 8000);
  }

  scheduleRestart(service, delay) {
    if (this.stopping) return;
    const existing = this.restartTimers.get(service);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.restartTimers.delete(service);
      this.startService(service);
    }, delay);
    timer.unref?.();
    this.restartTimers.set(service, timer);
  }

  handleLine(service, line) {
    if (!line || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.logger.warn(`[${service}] invalid JSON: ${line.slice(0, 160)}`);
      return;
    }

    if (message.type === "ready") {
      this.online[service] = true;
      this.errors[service] = null;
      this.emitState();
      return;
    }

    if (message.type === "ack") {
      if (message.ok === false && message.detail && process.env.ISLAND_DEBUG) {
        this.logger.warn(`[${service}] command failed: ${message.detail}`);
      }
      return;
    }

    if (message.type === "media-state" && service === "media") {
      this.applyMediaState(message.media || null);
      this.emitState({ mediaArtwork: message.media?.artwork || null });
      return;
    }

    if (message.type === "volume-state" && service === "volume") {
      if (message.volume && typeof message.volume === "object") {
        this.states.volume = {
          level: Number(message.volume.level) || 0,
          muted: Boolean(message.volume.muted),
          available: message.volume.available !== false,
        };
      }
      if (message.audio && typeof message.audio === "object") {
        this.states.audio = {
          output: String(message.audio.output || ""),
          outputId: String(message.audio.outputId || ""),
          outputs: Array.isArray(message.audio.outputs)
            ? message.audio.outputs
                .filter((item) => item && item.id && item.name)
                .map((item) => ({ id: String(item.id), name: String(item.name) }))
            : [],
          microphone: {
            name: String(message.audio.microphone?.name || "Microphone"),
            muted: Boolean(message.audio.microphone?.muted),
            available: message.audio.microphone?.available !== false,
          },
        };
      }
      this.emitState();
      return;
    }

    if (message.type === "system-state" && service === "system") {
      if (message.stats && typeof message.stats === "object") {
        this.states.system = message.stats;
        this.emitState();
      }
      return;
    }
  }

  applyMediaState(incoming) {
    if (!incoming) {
      this.states.media = null;
      this.cachedTrackKey = null;
      this.cachedArtwork = null;
      return;
    }

    const trackKey = incoming.trackKey || "";
    if (trackKey !== this.cachedTrackKey) {
      this.cachedTrackKey = trackKey;
      this.cachedArtwork = null;
    }
    if (incoming.artwork) {
      this.cachedArtwork = incoming.artwork;
    }

    const media = { ...incoming };
    delete media.artwork;
    delete media.artworkType;
    this.states.media = media;
  }

  status() {
    return {
      media: Boolean(this.online.media),
      volume: Boolean(this.online.volume),
      system: Boolean(this.online.system),
      errors: { ...this.errors },
    };
  }

  snapshot() {
    return {
      media: this.states.media
        ? { ...this.states.media, artwork: this.cachedArtwork || undefined }
        : null,
      volume: { ...this.states.volume },
      audio: {
        ...this.states.audio,
        outputs: [...this.states.audio.outputs],
        microphone: { ...this.states.audio.microphone },
      },
      system: this.states.system,
      status: this.status(),
    };
  }

  emitState(extra = {}) {
    const currentMedia = this.states.media;
    const media = currentMedia
      ? {
          ...currentMedia,
          ...(extra.mediaArtwork ? { artwork: extra.mediaArtwork } : {}),
        }
      : null;
    this.emit("state", {
      media,
      volume: { ...this.states.volume },
      audio: {
        ...this.states.audio,
        outputs: [...this.states.audio.outputs],
        microphone: { ...this.states.audio.microphone },
      },
      system: this.states.system,
      status: this.status(),
    });
  }

  send(service, command) {
    const child = this.children.get(service);
    if (!child || !child.stdin || child.stdin.destroyed || !this.online[service]) {
      return false;
    }
    const id = this.nextCommandId++;
    try {
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      return id;
    } catch (error) {
      this.errors[service] = error.message;
      return false;
    }
  }

  mediaCommand(action, options = {}) {
    return this.send("media", { type: "media", action, ...options });
  }

  seek(positionSeconds) {
    return this.send("media", { type: "seek", position: positionSeconds });
  }

  refreshMedia() {
    return this.send("media", { type: "media", action: "refresh" });
  }

  setVolume(level) {
    return this.send("volume", { type: "volume", value: level });
  }

  setMuted(muted) {
    return this.send("volume", { type: "mute", value: Boolean(muted) });
  }

  toggleMute() {
    return this.send("volume", { type: "toggle-mute" });
  }

  setMicMuted(muted) {
    return this.send("volume", { type: "mic-mute", value: Boolean(muted) });
  }

  setBrightness(level) {
    const value = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
    return this.send("system", { type: "brightness", value });
  };

  toggleMic() {
    return this.send("volume", { type: "toggle-mic" });
  }

  setOutputDevice(deviceId) {
    return this.send("volume", { type: "output", deviceId: String(deviceId || "") });
  }

  stop() {
    this.stopping = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    for (const child of this.children.values()) {
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill();
      } catch {}
    }
    this.children.clear();
    this.online = { media: false, volume: false, system: false };
  }
}

module.exports = { SystemBridge };
