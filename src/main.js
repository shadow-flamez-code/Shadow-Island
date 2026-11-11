"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  clipboard,
  desktopCapturer,
  dialog,
} = require("electron");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SystemBridge } = require("./system-bridge");

const WINDOW_WIDTH = 820;
const WINDOW_HEIGHT = 660;
const NOTIFY_PORT = Number(process.env.ISLAND_NOTIFY_PORT || 17891);
const APP_ID = "com.shadowisland.pc";
const PREVIEW_MODE = process.env.ISLAND_PREVIEW || "";
const SCREENSHOT_PATH = process.env.ISLAND_SCREENSHOT || "";
const CLIPBOARD_LIMIT = 36;
const CLIPBOARD_IMAGE_MAX = 3.5 * 1024 * 1024;
const LRCLIB_ENDPOINT = "https://lrclib.net/api";
const USER_AGENT = "ShadowIslandPC/1.0 (Windows desktop overlay)";

const isDev = !app.isPackaged;
let mainWindow = null;
let tray = null;
let bridge = null;
let notifyServer = null;
let isQuitting = false;
let panelOpen = false;
let alwaysOnTop = true;
let launchAtLogin = false;
let focusMode = false;
let lastBridgeState = null;
let firstRun = true;
// The collapsed overlay is resized to the visible pill so clicks outside the
// island fall through to the desktop instead of the transparent window.
let collapsedSize = { width: 460, height: 94 };
let boundsTimer = null;
let panelClosing = false;
/* Where the island lives: snapped to a screen edge (top/bottom/left/right
   plus a position along that edge) or floating at a free position. */
let dockState = { mode: "edge", edge: "top", offset: 0, x: 0, y: 0 };
let dragging = false;

const DEFAULT_APPEARANCE = {
  accentMode: "wallpaper", // "wallpaper" | "album" | "custom"
  accentPrimary: "#A855F7",
  accentSecondary: "#22D3EE",
  progressRing: true,
  hoverExpand: true,
  aurora: true,
  odometer: true,
  autoHideFullscreen: false,
  autoLightDark: true,
  themePack: "neon", // neon | oled | amber | ice
  soundReactive: true,
  glassPanel: false,
  holoAccent: true,
  capsuleFace: "clock", // clock | pomodoro | uptime
  dragTrail: true,
};
let appearance = { ...DEFAULT_APPEARANCE };
let clipboardHistory = [];
let clipboardLastSignature = "";
let clipboardTimer = null;
let lastImageProbe = 0;
let imageProbeWarned = false;
let customApps = [];
let activities = new Map();
const lyricsCache = new Map();

const BUILTIN_APPS = [
  {
    id: "explorer",
    name: "File Explorer",
    icon: "folder",
    kind: "path",
    target: path.join(process.env.WINDIR || "C:\\Windows", "explorer.exe"),
  },
  { id: "terminal", name: "Terminal", icon: "terminal", kind: "path", target: "cmd.exe" },
  { id: "settings", name: "Settings", icon: "gear", kind: "uri", target: "ms-settings:" },
  { id: "calculator", name: "Calculator", icon: "calculator", kind: "path", target: "calc.exe" },
  { id: "notepad", name: "Notepad", icon: "note", kind: "path", target: "notepad.exe" },
  { id: "taskmgr", name: "Task Manager", icon: "pulse", kind: "path", target: "taskmgr.exe" },
  { id: "camera", name: "Camera", icon: "camera", kind: "uri", target: "microsoft.windows.camera:" },
  { id: "browser", name: "Browser", icon: "globe", kind: "url", target: "https://www.google.com" },
];

function projectRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
}

function bridgeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bridge")
    : path.join(__dirname, "..", "bridge");
}

function assetPath(name) {
  return path.join(projectRoot(), "assets", name);
}

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function clipboardFile() {
  return path.join(app.getPath("userData"), "clipboard.json");
}

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    firstRun = false;
    if (typeof settings.alwaysOnTop === "boolean") alwaysOnTop = settings.alwaysOnTop;
    if (typeof settings.launchAtLogin === "boolean") launchAtLogin = settings.launchAtLogin;
    if (settings.appearance && typeof settings.appearance === "object") {
      const incoming = settings.appearance;
      const hex = (value, fallback) =>
        /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
      appearance = {
        accentMode:
          incoming.accentMode === "album" || incoming.accentMode === "custom"
            ? incoming.accentMode
            : "wallpaper",
        accentPrimary: hex(incoming.accentPrimary, DEFAULT_APPEARANCE.accentPrimary),
        accentSecondary: hex(incoming.accentSecondary, DEFAULT_APPEARANCE.accentSecondary),
        progressRing: incoming.progressRing !== false,
        hoverExpand: incoming.hoverExpand !== false,
        aurora: incoming.aurora !== false,
        odometer: incoming.odometer !== false,
        autoHideFullscreen: incoming.autoHideFullscreen === true,
        autoLightDark: incoming.autoLightDark !== false,
        themePack: ["neon", "oled", "amber", "ice"].includes(incoming.themePack)
          ? incoming.themePack
          : "neon",
        soundReactive: incoming.soundReactive !== false,
        glassPanel: incoming.glassPanel === true,
        holoAccent: incoming.holoAccent !== false,
        capsuleFace: ["clock", "pomodoro", "uptime"].includes(incoming.capsuleFace)
          ? incoming.capsuleFace
          : "clock",
        dragTrail: incoming.dragTrail !== false,
      };
    }
    if (settings.dock && typeof settings.dock === "object") {
      const edge = ["top", "bottom", "left", "right"].includes(settings.dock.edge)
        ? settings.dock.edge
        : "top";
      dockState = {
        mode: settings.dock.mode === "free" ? "free" : "edge",
        edge,
        offset: Math.max(-1, Math.min(1, Number(settings.dock.offset) || 0)),
        x: Math.round(Number(settings.dock.x) || 0),
        y: Math.round(Number(settings.dock.y) || 0),
      };
    }
    if (Array.isArray(settings.launcherApps)) {
      customApps = settings.launcherApps
        .filter((item) => item && typeof item.target === "string")
        .map((item) => ({
          id: String(item.id || `app_${Math.random().toString(36).slice(2, 8)}`),
          name: String(item.name || "App").slice(0, 40),
          icon: String(item.icon || "app"),
          kind: item.kind === "url" ? "url" : item.kind === "uri" ? "uri" : "path",
          target: item.target,
        }));
    }
  } catch {}
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify(
        {
          alwaysOnTop,
          launchAtLogin,
          launcherApps: customApps,
          appearance,
          dock: {
            mode: dockState.mode,
            edge: dockState.edge,
            offset: dockState.offset,
            x: dockState.x,
            y: dockState.y,
          },
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.error("Could not save settings:", error.message);
  }
}

function loadClipboard() {
  try {
    const data = JSON.parse(fs.readFileSync(clipboardFile(), "utf8"));
    if (Array.isArray(data.entries)) {
      clipboardHistory = data.entries
        .filter((item) => item && (item.text || item.dataUrl))
        .slice(0, CLIPBOARD_LIMIT)
        .map((item) => ({
          id: String(item.id || `clip_${Math.random().toString(36).slice(2, 9)}`),
          type: ["text", "link", "image"].includes(item.type) ? item.type : "text",
          text: String(item.text || "").slice(0, 8000),
          dataUrl: typeof item.dataUrl === "string" ? item.dataUrl : "",
          at: Number(item.at) || Date.now(),
          pinned: Boolean(item.pinned),
          sig: String(item.sig || ""),
        }));
    }
  } catch {}
}

function saveClipboard() {
  try {
    fs.mkdirSync(path.dirname(clipboardFile()), { recursive: true });
    fs.writeFileSync(clipboardFile(), JSON.stringify({ entries: clipboardHistory }), "utf8");
  } catch (error) {
    console.error("Could not save clipboard history:", error.message);
  }
}

function startPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function applyLoginSetting() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: launchAtLogin, path: startPath(), args: [] });
  } catch (error) {
    console.error("Could not update login item:", error.message);
  }
}

function positionWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyWindowBounds();
}

/* Keeps the overlay window exactly as large as the visible island: the
   compact pill when collapsed, the full dashboard when open. A window larger
   than the artwork swallows clicks meant for the desktop underneath. */
function applyWindowBounds(animate = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  let bounds;
  if (panelOpen) {
    bounds = {
      x: Math.round(area.x + (area.width - WINDOW_WIDTH) / 2),
      y: area.y,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    };
  } else {
    const width = Math.max(80, Math.min(WINDOW_WIDTH, Math.round(collapsedSize.width)));
    const height = Math.max(60, Math.min(WINDOW_HEIGHT, Math.round(collapsedSize.height)));
    bounds = dockBounds(area, width, height);
  }
  const current = mainWindow.getBounds();
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) {
    return;
  }
  if (!animate || dragging) {
    stopBoundsAnimation();
    mainWindow.setBounds(bounds, false);
    return;
  }
  animateBounds(current, bounds);
}

/* Places the island on its docked edge (or at its free floating spot).
   The island itself sits flush against the edge — the window only carries
   the margin that lets the glow fade out. */
function dockBounds(area, width, height) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const frame = islandFrame(width, height);
  if (dockState.mode === "free") {
    return {
      x: Math.round(clamp(dockState.x, area.x, area.x + area.width - width)),
      y: Math.round(clamp(dockState.y, area.y, area.y + area.height - height)),
      width,
      height,
    };
  }
  const edge = dockState.edge;
  const offset = clamp(Number(dockState.offset) || 0, -1, 1);
  if (edge === "left" || edge === "right") {
    return {
      x: Math.round(
        edge === "left"
          ? area.x - frame.x
          : area.x + area.width - frame.islandWidth - frame.x
      ),
      y: Math.round(
        clamp(
          area.y + area.height / 2 + offset * (area.height / 2) - height / 2,
          area.y,
          area.y + area.height - height
        )
      ),
      width,
      height,
    };
  }
  return {
    x: Math.round(
      clamp(
        area.x + area.width / 2 + offset * (area.width / 2) - width / 2,
        area.x,
        area.x + area.width - width
      )
    ),
    y: Math.round(
      edge === "bottom"
        ? area.y + area.height - frame.islandHeight - frame.y
        : area.y - frame.y
    ),
    width,
    height,
  };
}

/* How the island sits inside its window: the offsets of its top-left
   corner plus its own size, so the window can be pushed past the screen
   edge and the capsule still lands flush on it. */
function islandFrame(width, height) {
  const margin = 48;
  const islandWidth = Math.max(1, width - margin);
  const islandHeight = Math.max(1, height - (height > width ? margin : 58));
  const vertical = islandHeight > islandWidth;
  return vertical
    ? { x: 24, y: 24, islandWidth, islandHeight }
    : { x: 24, y: 10, islandWidth, islandHeight };
}

/* The window follows the pill instead of snapping to its new size, so the
   island never appears to jump while it grows or shrinks. The centre stays
   on the same pixel and the width always stays even — otherwise the digits
   inside the capsule shimmer by fractions of a pixel on every frame. */
function animateBounds(from, to) {
  stopBoundsAnimation();
  const startedAt = Date.now();
  const duration = 420;
  const centerX = Math.round(from.x + from.width / 2);
  const step = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      boundsTimer = null;
      return;
    }
    const t = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const width = Math.max(
      60,
      2 * Math.round((from.width + (to.width - from.width) * eased) / 2)
    );
    const height = Math.max(
      40,
      Math.round(from.height + (to.height - from.height) * eased)
    );
    mainWindow.setBounds(
      {
        x: centerX - width / 2,
        y: Math.round(from.y + (to.y - from.y) * eased),
        width,
        height,
      },
      false
    );
    if (t < 1) {
      boundsTimer = setTimeout(step, 16);
    } else {
      boundsTimer = null;
    }
  };
  boundsTimer = setTimeout(step, 16);
}

function stopBoundsAnimation() {
  if (boundsTimer) {
    clearTimeout(boundsTimer);
    boundsTimer = null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: Math.max(240, Math.round(collapsedSize.width)),
    height: Math.max(60, Math.round(collapsedSize.height)),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop,
    title: "Shadow Island",
    icon: assetPath("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  // The island lives in the tray only — it must never claim a taskbar slot.
  mainWindow.setSkipTaskbar(true);
  mainWindow.setAlwaysOnTop(alwaysOnTop, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  const target = path.join(__dirname, "..", "renderer", "index.html");
  if (PREVIEW_MODE) {
    mainWindow.loadFile(target, { query: { preview: PREVIEW_MODE } });
  } else {
    mainWindow.loadFile(target);
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.setSkipTaskbar(true);
    positionWindow();
    if (SCREENSHOT_PATH) {
      mainWindow.show();
    } else {
      mainWindow.showInactive();
    }
  });

  mainWindow.on("blur", () => {
    if (!panelOpen) return;
    panelOpen = false;
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.webContents.send("island:collapse");
    applyWindowBounds();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    updateTrayMenu();
  });

  mainWindow.webContents.on("devtools-opened", () => {
    mainWindow.setIgnoreMouseEvents(false);
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
    mainWindow.setIgnoreMouseEvents(false);
  }

  if (SCREENSHOT_PATH) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(SCREENSHOT_PATH, image.toPNG());
          console.log(`Screenshot saved to ${SCREENSHOT_PATH}`);
        } catch (error) {
          console.error("Screenshot failed:", error.message);
        } finally {
          isQuitting = true;
          app.quit();
        }
      }, 2800);
    });
  }
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function showIsland() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  positionWindow();
  // Re-assert the tray-only presence every time the island comes back.
  mainWindow.setSkipTaskbar(true);
  mainWindow.showInactive();
  updateTrayMenu();
}

function hideIsland() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  panelOpen = false;
  updateTrayMenu();
}

function toggleVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) hideIsland();
  else showIsland();
}

function togglePanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) showIsland();
  send("island:toggle-panel");
}

function openTab(tab) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) showIsland();
  send("island:open-tab", tab);
}

function showTestNotification() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) showIsland();
  send("island:notification", {
    app: "Shadow Island",
    title: "Shadow Island is awake",
    body: "Press Ctrl + Alt + I anytime to open the control center.",
    duration: 5200,
  });
}

function setFocusMode(value) {
  focusMode = Boolean(value);
  updateTrayMenu();
  send("island:focus-state", focusMode);
  if (focusMode) {
    send("island:notification", {
      app: "Focus",
      title: "Focus mode on",
      body: "Notification popups are paused until you turn it off.",
      duration: 4200,
      tone: "focus",
    });
  }
}

function clickThrough(interactive) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

/* Puts a screenshot of the desktop into the clipboard shelf. */
async function captureScreenToShelf() {
  try {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 2560, height: 1440 },
    });
    const source =
      sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
    if (!source) return;
    const png = source.thumbnail.toPNG();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const sig = clipboardSignature("image", `capture:${Date.now()}`, dataUrl);
    pushClipboardEntry({
      id: `clip_${crypto.randomBytes(6).toString("hex")}`,
      type: "image",
      text: "Screen capture",
      dataUrl,
      at: Date.now(),
      pinned: false,
      sig,
    });
    send("island:notification", {
      app: "Shadow Island",
      title: "Screen captured",
      body: "The screenshot landed in your clipboard shelf.",
      tone: "success",
      duration: 3200,
    });
  } catch (error) {
    console.error("Screen capture failed:", error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard manager                                                   */
/* ------------------------------------------------------------------ */

function clipboardSignature(type, text, dataUrl) {
  return crypto
    .createHash("sha1")
    .update(type)
    .update(text || "")
    .update((dataUrl || "").slice(0, 4096))
    .digest("hex");
}

function broadcastClipboard() {
  send("island:clipboard", clipboardHistory.map((item) => ({ ...item, sig: undefined })));
}

function pushClipboardEntry(entry) {
  clipboardHistory.unshift(entry);
  const pinned = clipboardHistory.filter((item) => item.pinned);
  const rest = clipboardHistory.filter((item) => !item.pinned).slice(0, CLIPBOARD_LIMIT);
  clipboardHistory = [...pinned.slice(0, 12), ...rest];
  saveClipboard();
  broadcastClipboard();
}

function pollClipboard() {
  try {
    const text = clipboard.readText().trim();
    let type = "";
    let dataUrl = "";
    let value = "";
    if (text) {
      value = text.slice(0, 8000);
      type = /^(https?:\/\/|www\.)\S+$/i.test(value) ? "link" : "text";
    } else if (Date.now() - lastImageProbe > 5000) {
      // Electron 45 throws inside clipboard.readImage() on Windows, so the
      // image probe is rare and never spams the log.
      lastImageProbe = Date.now();
      try {
        const image = clipboard.readImage();
        if (!image.isEmpty()) {
          dataUrl = image.toDataURL();
          if (dataUrl.length <= CLIPBOARD_IMAGE_MAX * 1.4) type = "image";
        }
      } catch (error) {
        if (!imageProbeWarned) {
          imageProbeWarned = true;
          console.warn("Clipboard image probe unavailable:", error.message);
        }
      }
    }
    if (!type) return;
    const sig = clipboardSignature(type, value, dataUrl);
    if (sig === clipboardLastSignature) return;
    clipboardLastSignature = sig;
    if (clipboardHistory[0]?.sig === sig) return;
    pushClipboardEntry({
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      text: value,
      dataUrl,
      at: Date.now(),
      pinned: false,
      sig,
    });
  } catch (error) {
    if (process.env.ISLAND_DEBUG) console.error("Clipboard poll failed:", error.message);
  }
}

function startClipboardWatcher() {
  loadClipboard();
  try {
    clipboardLastSignature = "";
    pollClipboard();
  } catch {}
  clipboardTimer = setInterval(pollClipboard, 900);
  clipboardTimer.unref?.();
}

function copyClipboardEntry(id) {
  const entry = clipboardHistory.find((item) => item.id === id);
  if (!entry) return false;
  if (entry.type === "image" && entry.dataUrl) {
    const image = nativeImage.createFromDataURL(entry.dataUrl);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
  } else {
    clipboard.writeText(entry.text || "");
  }
  clipboardLastSignature = entry.sig || clipboardSignature(entry.type, entry.text, entry.dataUrl);
  return true;
}

/* ------------------------------------------------------------------ */
/* App launcher                                                        */
/* ------------------------------------------------------------------ */

function launcherList() {
  return [
    ...BUILTIN_APPS.map(({ target, ...item }) => ({ ...item, builtin: true })),
    ...customApps.map(({ target, ...item }) => ({ ...item, builtin: false })),
  ];
}

function broadcastLauncher() {
  send("island:launcher-list", launcherList());
}

function findLauncherApp(id) {
  return BUILTIN_APPS.find((item) => item.id === id) || customApps.find((item) => item.id === id);
}

function launchApp(id) {
  const appInfo = findLauncherApp(id);
  if (!appInfo) return false;
  try {
    if (appInfo.kind === "url") {
      shell.openExternal(appInfo.target);
      return true;
    }
    if (appInfo.kind === "uri") {
      shell.openExternal(appInfo.target);
      return true;
    }
    if (path.isAbsolute(appInfo.target)) {
      const error = shell.openPath(appInfo.target);
      // openPath returns a promise in modern Electron; fire and forget.
      if (error && typeof error.catch === "function") error.catch(() => {});
      return true;
    }
    const child = spawn(appInfo.target, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return true;
  } catch (error) {
    console.error("Launch failed:", error.message);
    return false;
  }
}

async function addLauncherApp() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Pin an app to the island",
    properties: ["openFile"],
    filters: [
      { name: "Apps and shortcuts", extensions: ["exe", "lnk", "bat", "cmd"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const target = result.filePaths[0];
  const name = path.basename(target, path.extname(target)).slice(0, 40) || "App";
  const appInfo = {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    icon: "app",
    kind: "path",
    target,
  };
  customApps.push(appInfo);
  saveSettings();
  broadcastLauncher();
  return { ...appInfo, target: undefined, builtin: false };
}

function addLauncherUrl(payload) {
  if (!payload || typeof payload !== "object") return null;
  let url;
  try {
    url = new URL(String(payload.url || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const name = String(payload.name || url.hostname.replace(/^www\./, "")).trim().slice(0, 40);
  if (!name) return null;
  const appInfo = {
    id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    icon: "globe",
    kind: "url",
    target: url.toString(),
  };
  customApps.push(appInfo);
  saveSettings();
  broadcastLauncher();
  return { ...appInfo, target: undefined, builtin: false };
}

function removeLauncherApp(id) {
  const before = customApps.length;
  customApps = customApps.filter((item) => item.id !== id);
  if (customApps.length !== before) {
    saveSettings();
    broadcastLauncher();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

const ACTIVITY_ICONS = new Set([
  "nav",
  "download",
  "render",
  "food",
  "ride",
  "flight",
  "sports",
  "sync",
  "timer",
  "generic",
]);

function activityList() {
  return [...activities.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function broadcastActivities() {
  send("island:activities", activityList());
}

function sanitizeActivity(payload) {
  if (!payload || typeof payload !== "object") return null;
  const title = String(payload.title || "").trim().slice(0, 80);
  if (!title) return null;
  const rawId = payload.id ? String(payload.id) : "";
  const id = (rawId || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`).slice(0, 64);
  const existing = activities.get(id);
  const hasProgress =
    payload.progress !== null &&
    payload.progress !== undefined &&
    payload.progress !== "" &&
    Number.isFinite(Number(payload.progress));
  const progress = hasProgress ? Math.max(0, Math.min(100, Number(payload.progress))) : null;
  const accent = String(payload.accent || "");
  return {
    id,
    title,
    subtitle: String(payload.subtitle || payload.detail || "").slice(0, 140),
    progress,
    status:
      payload.status === "done" || payload.status === "paused"
        ? payload.status
        : progress !== null && progress >= 100
          ? "done"
          : "active",
    icon: ACTIVITY_ICONS.has(payload.icon) ? payload.icon : "generic",
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#8b5cf6",
    eta: String(payload.eta || "").slice(0, 40),
    kind: String(payload.kind || "progress").slice(0, 24),
    steps: Array.isArray(payload.steps)
      ? payload.steps.slice(0, 6).map((step) => String(step).slice(0, 70))
      : existing?.steps || [],
    updatedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
  };
}

function addActivity(payload) {
  const activity = sanitizeActivity(payload);
  if (!activity) return null;
  activities.set(activity.id, activity);
  broadcastActivities();
  return activity;
}

function removeActivity(id) {
  const removed = activities.delete(String(id));
  if (removed) broadcastActivities();
  return removed;
}

/* ------------------------------------------------------------------ */
/* Lyrics (LRCLIB)                                                     */
/* ------------------------------------------------------------------ */

function parseLrc(lrc) {
  const lines = [];
  const timePattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of String(lrc || "").split(/\r?\n/)) {
    const content = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!content) continue;
    let match;
    let found = false;
    timePattern.lastIndex = 0;
    while ((match = timePattern.exec(raw))) {
      found = true;
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(match[3].padEnd(3, "0")) / 1000 : 0;
      lines.push({
        time: Math.max(0, minutes * 60 + seconds + fraction),
        text: content.slice(0, 220),
      });
    }
    if (!found) continue;
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

async function fetchLyrics(query) {
  if (!query || typeof query !== "object") return { synced: [], plain: "", matched: null };
  const track = String(query.title || "").trim();
  const artist = String(query.artist || "").trim();
  if (!track) return { synced: [], plain: "", matched: null };
  const cacheKey = `${track.toLowerCase()}|${artist.toLowerCase()}`;
  const cached = lyricsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;

  const params = new URLSearchParams({ track_name: track });
  if (artist && artist !== "Unknown artist") params.set("artist_name", artist);
  const url = `${LRCLIB_ENDPOINT}/search?${params.toString()}`;
  let results = [];
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(9000),
    });
    if (response.ok) results = await response.json();
  } catch (error) {
    if (process.env.ISLAND_DEBUG) console.error("Lyrics fetch failed:", error.message);
  }

  if (!Array.isArray(results) || !results.length) {
    const miss = { synced: [], plain: "", matched: null };
    lyricsCache.set(cacheKey, { at: Date.now(), data: miss });
    return miss;
  }

  const preferred =
    results.find((item) => item.syncedLyrics) ||
    results.find((item) => item.plainLyrics) ||
    results[0];
  const data = {
    synced: preferred?.syncedLyrics ? parseLrc(preferred.syncedLyrics) : [],
    plain: String(preferred?.plainLyrics || "").slice(0, 12000),
    matched: preferred
      ? {
          title: String(preferred.trackName || "").slice(0, 120),
          artist: String(preferred.artistName || "").slice(0, 120),
          album: String(preferred.albumName || "").slice(0, 120),
          duration: Number(preferred.duration) || 0,
        }
      : null,
    source: "LRCLIB",
  };
  lyricsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function describeDroppedFiles(paths) {
  const items = [];
  for (const raw of Array.isArray(paths) ? paths.slice(0, 40) : []) {
    const filePath = String(raw || "");
    if (!filePath) continue;
    try {
      const stat = fs.statSync(filePath);
      items.push({
        path: filePath,
        name: path.basename(filePath) || filePath,
        dir: path.dirname(filePath),
        size: stat.isFile() ? stat.size : 0,
        isDir: stat.isDirectory(),
        ext: path.extname(filePath).replace(".", "").toLowerCase().slice(0, 8),
        at: Date.now(),
      });
    } catch {}
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function senderIsMain(event) {
  return Boolean(mainWindow) && event.sender === mainWindow.webContents;
}

function setupIpc() {
  ipcMain.on("island:interactive", (event, interactive) => {
    if (!senderIsMain(event)) return;
    clickThrough(Boolean(interactive));
  });

  ipcMain.on("island:panel-state", (event, open) => {
    if (!senderIsMain(event)) return;
    if (open) {
      panelClosing = false;
      panelOpen = true;
      // The dashboard unfolds out of the pill on screen, so the window has
      // to be full size straight away — otherwise the panel would slide
      // sideways while it grows.
      applyWindowBounds(false);
      mainWindow.setIgnoreMouseEvents(false);
      mainWindow.focus();
      return;
    }
    panelOpen = false;
    panelClosing = true;
    // Give the panel time to fold back into the pill before the window
    // shrinks again, otherwise the animation gets clipped.
    setTimeout(() => {
      panelClosing = false;
      if (!panelOpen) applyWindowBounds(false);
    }, 480);
  });

  ipcMain.on("island:resize", (event, size) => {
    if (!senderIsMain(event) || !size || typeof size !== "object") return;
    const width = Number(size.width);
    const height = Number(size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    collapsedSize = {
      width: Math.max(80, Math.min(WINDOW_WIDTH, Math.round(width))),
      height: Math.max(60, Math.min(WINDOW_HEIGHT, Math.round(height))),
    };
    if (!panelOpen && !panelClosing) applyWindowBounds(true);
  });

  ipcMain.on("island:open-external", (event, url) => {
    if (!senderIsMain(event)) return;
    const value = String(url || "");
    if (!/^https?:\/\//i.test(value)) return;
    shell.openExternal(value).catch(() => {});
  });

  ipcMain.handle("island:work-area", (event) => {
    if (!senderIsMain(event)) return null;
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  });

  ipcMain.handle("island:capture-screen", async (event) => {
    if (!senderIsMain(event)) return null;
    try {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 2560, height: 1440 },
      });
      const source =
        sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
      if (!source) return null;
      const png = source.thumbnail.toPNG();
      return `data:image/png;base64,${png.toString("base64")}`;
    } catch (error) {
      console.error("Screen capture failed:", error.message);
      return null;
    }
  });

  ipcMain.on("island:clipboard-image", (event, dataUrl) => {
    if (!senderIsMain(event) || typeof dataUrl !== "string") return;
    if (!dataUrl.startsWith("data:image/")) return;
    const sig = clipboardSignature("image", `capture:${Date.now()}`, dataUrl);
    pushClipboardEntry({
      id: `clip_${crypto.randomBytes(6).toString("hex")}`,
      type: "image",
      text: "Screen capture",
      dataUrl,
      at: Date.now(),
      pinned: false,
      sig,
    });
  });

  ipcMain.on("island:dragging", (event, value) => {
    if (!senderIsMain(event)) return;
    dragging = Boolean(value);
    if (!dragging) applyWindowBounds(false);
  });

  ipcMain.on("island:drag-move", (event, position) => {
    if (!senderIsMain(event) || !mainWindow || mainWindow.isDestroyed()) return;
    const x = Math.round(Number(position?.x) || 0);
    const y = Math.round(Number(position?.y) || 0);
    mainWindow.setPosition(x, y, false);
  });

  ipcMain.on("island:dock", (event, dock) => {
    if (!senderIsMain(event) || !dock || typeof dock !== "object") return;
    const edge = ["top", "bottom", "left", "right"].includes(dock.edge) ? dock.edge : "top";
    dockState = {
      mode: dock.mode === "free" ? "free" : "edge",
      edge,
      offset: Math.max(-1, Math.min(1, Number(dock.offset) || 0)),
      x: Math.round(Number(dock.x) || 0),
      y: Math.round(Number(dock.y) || 0),
    };
    if (Number(dock.width) > 0) {
      collapsedSize = {
        width: Math.round(Number(dock.width)),
        height: Math.round(Number(dock.height) || collapsedSize.height),
      };
    }
    saveSettings();
    if (process.env.ISLAND_DEBUG) {
      console.log("[dock]", JSON.stringify(dockState), JSON.stringify(collapsedSize));
    }
    applyWindowBounds(Boolean(dock.animate));
  });

  ipcMain.on("island:renderer-ready", (event) => {
    if (!senderIsMain(event)) return;
    send("island:bridge-state", bridge ? bridge.snapshot() : null);
    send("island:app-info", {
      version: app.getVersion(),
      packaged: app.isPackaged,
      focusMode,
    });
    broadcastClipboard();
    broadcastLauncher();
    broadcastActivities();
  });

  ipcMain.on("island:media-command", (event, action) => {
    if (!senderIsMain(event)) return;
    const allowed = new Set(["toggle", "play", "pause", "next", "previous", "stop", "refresh"]);
    if (!allowed.has(action)) return;
    bridge?.mediaCommand(action);
  });

  ipcMain.on("island:seek", (event, seconds) => {
    if (!senderIsMain(event)) return;
    const value = Number(seconds);
    if (!Number.isFinite(value)) return;
    bridge?.seek(Math.max(0, value));
  });

  ipcMain.on("island:volume", (event, level) => {
    if (!senderIsMain(event)) return;
    const value = Math.max(0, Math.min(1, Number(level)));
    if (Number.isFinite(value)) bridge?.setVolume(value);
  });

  ipcMain.on("island:muted", (event, muted) => {
    if (!senderIsMain(event)) return;
    bridge?.setMuted(Boolean(muted));
  });

  ipcMain.on("island:mic-muted", (event, muted) => {
    if (!senderIsMain(event)) return;
    bridge?.setMicMuted(Boolean(muted));
  });

  ipcMain.on("island:mic-toggle", (event) => {
    if (!senderIsMain(event)) return;
    bridge?.toggleMic();
  });

  ipcMain.on("island:output-device", (event, deviceId) => {
    if (!senderIsMain(event)) return;
    bridge?.setOutputDevice(String(deviceId || ""));
  });

  ipcMain.on("island:brightness", (event, level) => {
    if (!senderIsMain(event)) return;
    const value = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
    bridge?.setBrightness(value);
  });

  ipcMain.on("island:request-close", () => {
    mainWindow?.webContents.send("island:collapse");
  });

  ipcMain.on("island:focus", (event, value) => {
    if (!senderIsMain(event)) return;
    setFocusMode(Boolean(value));
  });

  ipcMain.on("island:open-path", (event, filePath) => {
    if (!senderIsMain(event)) return;
    const value = String(filePath || "");
    if (!value || !fs.existsSync(value)) return;
    shell.openPath(value);
  });

  ipcMain.on("island:reveal-path", (event, filePath) => {
    if (!senderIsMain(event)) return;
    const value = String(filePath || "");
    if (!value || !fs.existsSync(value)) return;
    shell.showItemInFolder(value);
  });

  ipcMain.on("island:bluetooth-open", (event) => {
    if (!senderIsMain(event)) return;
    shell
      .openExternal("ms-settings:bluetooth")
      .catch((error) => console.error("Bluetooth settings open failed:", error.message));
  });

  ipcMain.on("island:network-open", (event) => {
    if (!senderIsMain(event)) return;
    shell
      .openExternal("ms-settings:network")
      .catch((error) => console.error("Network settings open failed:", error.message));
  });

  ipcMain.on("island:hide", (event) => {
    if (!senderIsMain(event)) return;
    hideIsland();
  });

  ipcMain.on("island:quit", (event) => {
    if (!senderIsMain(event)) return;
    isQuitting = true;
    app.quit();
  });

  ipcMain.handle("island:get-notes", () => {
    try {
      const notesFile = path.join(app.getPath("userData"), "notes.txt");
      return fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").slice(0, 8000) : "";
    } catch {
      return "";
    }
  });

  ipcMain.handle("island:save-notes", (event, value) => {
    if (!senderIsMain(event)) return false;
    try {
      const notesFile = path.join(app.getPath("userData"), "notes.txt");
      fs.mkdirSync(path.dirname(notesFile), { recursive: true });
      fs.writeFileSync(notesFile, String(value || "").slice(0, 8000), "utf8");
      return true;
    } catch (error) {
      console.error("Could not save notes:", error.message);
      return false;
    }
  });

  ipcMain.handle("island:get-settings", () => ({
    ...appearance,
    launchAtLogin,
    alwaysOnTop,
    dock: {
      mode: dockState.mode,
      edge: dockState.edge,
      offset: dockState.offset,
    },
  }));

  ipcMain.handle("island:save-settings", (event, patch) => {
    if (!senderIsMain(event) || !patch || typeof patch !== "object") return { ...appearance };
    const hex = (value, fallback) =>
      /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
    if (patch.accentMode === "album" || patch.accentMode === "custom") {
      appearance.accentMode = patch.accentMode;
    } else if (patch.accentMode === "wallpaper") {
      appearance.accentMode = "wallpaper";
    }
    if ("accentPrimary" in patch) appearance.accentPrimary = hex(patch.accentPrimary, appearance.accentPrimary);
    if ("accentSecondary" in patch) appearance.accentSecondary = hex(patch.accentSecondary, appearance.accentSecondary);
    for (const key of [
      "progressRing",
      "hoverExpand",
      "aurora",
      "odometer",
      "autoHideFullscreen",
      "autoLightDark",
      "soundReactive",
      "glassPanel",
      "holoAccent",
      "dragTrail",
    ]) {
      if (key in patch) appearance[key] = Boolean(patch[key]);
    }
    if ("themePack" in patch) {
      const pack = String(patch.themePack || "");
      if (["neon", "oled", "amber", "ice"].includes(pack)) appearance.themePack = pack;
    }
    if ("capsuleFace" in patch) {
      const face = String(patch.capsuleFace || "");
      if (["clock", "pomodoro", "uptime"].includes(face)) appearance.capsuleFace = face;
    }
    if ("launchAtLogin" in patch) {
      launchAtLogin = Boolean(patch.launchAtLogin);
      applyLoginSetting();
    }
    saveSettings();
    return { ...appearance, launchAtLogin, alwaysOnTop };
  });

  ipcMain.on("island:clipboard-copy", (event, id) => {
    if (!senderIsMain(event)) return;
    copyClipboardEntry(String(id || ""));
  });

  ipcMain.on("island:clipboard-write", (event, text) => {
    if (!senderIsMain(event)) return;
    const value = String(text || "");
    if (!value) return;
    clipboard.writeText(value);
    clipboardLastSignature = clipboardSignature(
      /^(https?:\/\/|www\.)\S+$/i.test(value) ? "link" : "text",
      value,
      ""
    );
  });

  ipcMain.on("island:clipboard-pin", (event, id) => {
    if (!senderIsMain(event)) return;
    const entry = clipboardHistory.find((item) => item.id === id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    saveClipboard();
    broadcastClipboard();
  });

  ipcMain.on("island:clipboard-delete", (event, id) => {
    if (!senderIsMain(event)) return;
    const before = clipboardHistory.length;
    clipboardHistory = clipboardHistory.filter((item) => item.id !== id);
    if (clipboardHistory.length !== before) {
      saveClipboard();
      broadcastClipboard();
    }
  });

  ipcMain.on("island:clipboard-clear", (event) => {
    if (!senderIsMain(event)) return;
    clipboardHistory = clipboardHistory.filter((item) => item.pinned);
    saveClipboard();
    broadcastClipboard();
  });

  ipcMain.handle("island:get-clipboard", (event) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return clipboardHistory.map((item) => ({ ...item, sig: undefined }));
  });

  ipcMain.handle("island:get-launcher", (event) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return launcherList();
  });

  ipcMain.on("island:launch-app", (event, id) => {
    if (!senderIsMain(event)) return;
    launchApp(String(id || ""));
  });

  ipcMain.handle("island:launcher-add", (event) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return addLauncherApp();
  });

  ipcMain.handle("island:launcher-add-url", (event, payload) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return addLauncherUrl(payload);
  });

  ipcMain.on("island:launcher-remove", (event, id) => {
    if (!senderIsMain(event)) return;
    removeLauncherApp(String(id || ""));
  });

  ipcMain.handle("island:lyrics", async (event, query) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return fetchLyrics(query);
  });

  ipcMain.handle("island:get-activities", (event) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return activityList();
  });

  ipcMain.handle("island:activity-add", (event, payload) => {
    if (!senderIsMain(event)) throw new Error("Unauthorized");
    return addActivity(payload);
  });

  ipcMain.on("island:activity-remove", (event, id) => {
    if (!senderIsMain(event)) return;
    removeActivity(String(id || ""));
  });

  ipcMain.on("island:files-dropped", (event, paths) => {
    if (!senderIsMain(event)) return;
    const items = describeDroppedFiles(paths);
    if (items.length) send("island:files-dropped", items);
  });
}

/* The Python system bridge is the single telemetry source. Its
   sample_stats() already runs on a per-subsystem cadence
   (fast: cpu/ram/gpu/net ~1s · slow: privacy/battery/bt/wifi ~5-10s),
   so no parallel Electron-side loop competes with it. */

/* ------------------------------------------------------------------ */
/* Bridge                                                              */
/* ------------------------------------------------------------------ */

function setupBridge() {
  bridge = new SystemBridge({ bridgeRoot: bridgeRoot() });
  let lastTrackKey = "";
  let hiddenForFullscreen = false;
  bridge.on("state", (state) => {
    lastBridgeState = state;
    send("island:bridge-state", state);
    // Step aside while a fullscreen app has the foreground.
    const fullscreen = Boolean(state.system?.fullscreen);
    if (appearance.autoHideFullscreen && fullscreen !== hiddenForFullscreen) {
      hiddenForFullscreen = fullscreen;
      if (fullscreen) {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
          updateTrayMenu();
        }
      } else if (mainWindow && !mainWindow.isVisible()) {
        showIsland();
      }
    }
    // Keep the tray tooltip live with whatever is playing.
    if (tray) {
      const media = state.media;
      const key = media?.active ? media.trackKey || "" : "";
      if (key !== lastTrackKey) {
        lastTrackKey = key;
        tray.setToolTip(
          media?.active
            ? `${media.playing ? "▶" : "⏸"} ${media.title} — ${media.artist}`
            : "Shadow Island"
        );
      }
    }
  });
  bridge.start();
}

/* ------------------------------------------------------------------ */
/* HTTP API (notifications + activities)                               */
/* ------------------------------------------------------------------ */

function jsonResponse(response, status, payload) {
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

function readJsonBody(request, limit = 32 * 1024) {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    let done = false;
    request.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve({ error: "Payload too large", status: 413 });
        request.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve({ payload: JSON.parse(body || "{}") });
      } catch {
        resolve({ error: "Invalid JSON", status: 400 });
      }
    });
    request.on("error", () => {
      if (done) return;
      done = true;
      resolve({ error: "Request failed", status: 400 });
    });
  });
}

function setupNotificationServer() {
  notifyServer = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    let url;
    try {
      url = new URL(request.url || "/", `http://127.0.0.1:${NOTIFY_PORT}`);
    } catch {
      jsonResponse(response, 400, { ok: false, error: "Bad request" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        app: "Dynamic Island",
        version: app.getVersion(),
        focusMode,
        bridge: bridge ? bridge.status() : null,
        activities: activities.size,
        dock: { ...dockState },
        bounds: mainWindow ? mainWindow.getBounds() : null,
        computed: mainWindow
          ? dockBounds(
              screen.getPrimaryDisplay().workArea,
              collapsedSize.width,
              collapsedSize.height
            )
          : null,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/activities") {
      jsonResponse(response, 200, { ok: true, activities: activityList() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/notify") {
      const { payload, error, status } = await readJsonBody(request);
      if (error) {
        jsonResponse(response, status || 400, { ok: false, error });
        return;
      }
      const clean = sanitizeNotification(payload);
      if (!clean) {
        jsonResponse(response, 400, { ok: false, error: "title or body is required" });
        return;
      }
      if (focusMode) {
        jsonResponse(response, 200, { ok: true, suppressed: true, reason: "focus mode" });
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        jsonResponse(response, 503, { ok: false, error: "Island is not running" });
        return;
      }
      if (!mainWindow.isVisible()) showIsland();
      send("island:notification", clean);
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/activity") {
      const { payload, error, status } = await readJsonBody(request);
      if (error) {
        jsonResponse(response, status || 400, { ok: false, error });
        return;
      }
      const activity = addActivity(payload);
      if (!activity) {
        jsonResponse(response, 400, { ok: false, error: "title is required" });
        return;
      }
      jsonResponse(response, 200, { ok: true, activity });
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/activity")) {
      let id = url.searchParams.get("id") || "";
      if (!id && url.pathname !== "/activity") {
        id = decodeURIComponent(url.pathname.slice("/activity/".length));
      }
      if (!id) {
        jsonResponse(response, 400, { ok: false, error: "id is required" });
        return;
      }
      const removed = removeActivity(id);
      jsonResponse(response, removed ? 200 : 404, { ok: removed });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found" });
  });

  notifyServer.on("error", (error) => {
    console.error(`API server could not start on port ${NOTIFY_PORT}:`, error.message);
    notifyServer = null;
  });

  notifyServer.listen(NOTIFY_PORT, "127.0.0.1", () => {
    console.log(`API: http://127.0.0.1:${NOTIFY_PORT}/notify  |  /activities  |  /activity`);
  });
  notifyServer.unref?.();
}

function sanitizeNotification(payload) {
  if (!payload || typeof payload !== "object") return null;
  const title = String(payload.title || "").trim().slice(0, 90);
  const body = String(payload.body || payload.message || "").trim().slice(0, 220);
  if (!title && !body) return null;
  return {
    app: String(payload.app || payload.application || "Dynamic Island").trim().slice(0, 50),
    title: title || "New notification",
    body,
    duration: Math.max(2200, Math.min(20000, Number(payload.duration) || 5600)),
    tone: ["focus", "privacy", "power", "success"].includes(payload.tone)
      ? payload.tone
      : "default",
  };
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

function updateTrayMenu() {
  if (!tray) return;
  const template = [
    {
      label: mainWindow?.isVisible() ? "Hide island" : "Show island",
      click: toggleVisibility,
    },
    { label: "Open control center   Ctrl+Alt+I", click: togglePanel },
    { label: "Open clipboard   Ctrl+Alt+C", click: () => openTab("tools") },
    {
      label: "Reset island position",
      click: () => {
        dockState = { mode: "edge", edge: "top", offset: 0, x: 0, y: 0 };
        saveSettings();
        send("island:reset-dock");
        applyWindowBounds(true);
      },
    },
    { type: "separator" },
    { label: "Send test notification   Ctrl+Alt+N", click: showTestNotification },
    { label: "Play / pause   Ctrl+Alt+M", click: () => bridge?.mediaCommand("toggle") },
    { label: "Mute microphone", click: () => bridge?.toggleMic() },
    {
      label: "Focus mode",
      type: "checkbox",
      checked: focusMode,
      click: (item) => setFocusMode(item.checked),
    },
    { type: "separator" },
    {
      label: "Always on top",
      type: "checkbox",
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        mainWindow?.setAlwaysOnTop(alwaysOnTop, "screen-saver");
        saveSettings();
      },
    },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: launchAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        launchAtLogin = item.checked;
        applyLoginSetting();
        saveSettings();
      },
    },
    ...(isDev
      ? [{ label: "Launch at login (available in packaged app)", enabled: false }]
      : []),
    {
      label: "Reset position",
      click: () => {
        if (!mainWindow?.isVisible()) showIsland();
        positionWindow();
      },
    },
    { type: "separator" },
    {
      label: "Read me / help",
      click: () => {
        const readme = path.join(projectRoot(), "README.md");
        if (fs.existsSync(readme)) shell.openPath(readme);
      },
    },
    { type: "separator" },
    {
      label: "Quit Dynamic Island",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip("Shadow Island");
}

function createTray() {
  let icon;
  const iconPath = assetPath("tray.png");
  if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath);
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.on("click", toggleVisibility);
  tray.on("double-click", togglePanel);
  updateTrayMenu();
}

function registerShortcuts() {
  const shortcuts = [
    ["CommandOrControl+Alt+H", toggleVisibility, "Ctrl+Alt+H hide/show island"],
    ["CommandOrControl+Alt+I", togglePanel, "Ctrl+Alt+I toggle island"],
    ["CommandOrControl+Alt+C", () => openTab("tools"), "Ctrl+Alt+C open clipboard"],
    ["CommandOrControl+Alt+N", showTestNotification, "Ctrl+Alt+N test notification"],
    ["CommandOrControl+Alt+M", () => bridge?.mediaCommand("toggle"), "Ctrl+Alt+M play/pause"],
    ["CommandOrControl+Alt+F", () => setFocusMode(!focusMode), "Ctrl+Alt+F focus mode"],
    ["CommandOrControl+Alt+S", () => captureScreenToShelf(), "Ctrl+Alt+S capture screen"],
  ];
  for (const [accelerator, handler, label] of shortcuts) {
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, handler);
    } catch (error) {
      console.error(`Shortcut ${label} failed:`, error.message);
    }
    if (!registered) {
      console.error(`Shortcut unavailable (taken by another app): ${label}`);
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showIsland();
    togglePanel();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    loadSettings();
    setupIpc();
    createMainWindow();
    createTray();
    setupBridge();
    applyLoginSetting();
    setupNotificationServer();
    startClipboardWatcher();
    registerShortcuts();

    setTimeout(() => {
      if (firstRun) showTestNotification();
    }, 2500);

    screen.on("display-metrics-changed", positionWindow);
    screen.on("display-added", positionWindow);
    screen.on("display-removed", positionWindow);

    setTimeout(() => {
      if (mainWindow?.isVisible()) mainWindow.webContents.send("island:refresh-layout");
    }, 800);
  });
}

app.on("activate", () => {
  if (!mainWindow) createMainWindow();
  else showIsland();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (clipboardTimer) clearInterval(clipboardTimer);
  bridge?.stop();
  notifyServer?.close();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  // Keep running in the tray, like a proper little island.
});
