"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("islandAPI", {
  setInteractive(interactive) {
    ipcRenderer.send("island:interactive", Boolean(interactive));
  },
  setPanelState(open) {
    ipcRenderer.send("island:panel-state", Boolean(open));
  },
  resize(size) {
    ipcRenderer.send("island:resize", {
      width: Number(size?.width) || 0,
      height: Number(size?.height) || 0,
    });
  },
  setDragging(dragging) {
    ipcRenderer.send("island:dragging", Boolean(dragging));
  },
  dragMove(position) {
    ipcRenderer.send("island:drag-move", {
      x: Math.round(Number(position?.x) || 0),
      y: Math.round(Number(position?.y) || 0),
    });
  },
  setDock(dock) {
    ipcRenderer.send("island:dock", {
      mode: String(dock?.mode || "edge"),
      edge: String(dock?.edge || "top"),
      offset: Number(dock?.offset) || 0,
      x: Math.round(Number(dock?.x) || 0),
      y: Math.round(Number(dock?.y) || 0),
      width: Math.round(Number(dock?.width) || 0),
      height: Math.round(Number(dock?.height) || 0),
      animate: Boolean(dock?.animate),
    });
  },
  getWorkArea: () => ipcRenderer.invoke("island:work-area"),
  captureScreen: () => ipcRenderer.invoke("island:capture-screen"),
  addClipboardImage(dataUrl) {
    ipcRenderer.send("island:clipboard-image", String(dataUrl || ""));
  },
  openExternal(url) {
    ipcRenderer.send("island:open-external", String(url || ""));
  },
  rendererReady() {
    ipcRenderer.send("island:renderer-ready");
  },
  requestClose() {
    ipcRenderer.send("island:request-close");
  },
  mediaCommand(action) {
    ipcRenderer.send("island:media-command", action);
  },
  seek(seconds) {
    ipcRenderer.send("island:seek", Number(seconds));
  },
  setVolume(level) {
    ipcRenderer.send("island:volume", Number(level));
  },
  setMuted(muted) {
    ipcRenderer.send("island:muted", Boolean(muted));
  },
  setMicMuted(muted) {
    ipcRenderer.send("island:mic-muted", Boolean(muted));
  },
  toggleMic() {
    ipcRenderer.send("island:mic-toggle");
  },
  setOutputDevice(deviceId) {
    ipcRenderer.send("island:output-device", String(deviceId || ""));
  },
  setBrightness(level) {
    ipcRenderer.send("island:brightness", Number(level) || 0);
  },
  setFocus(value) {
    ipcRenderer.send("island:focus", Boolean(value));
  },
  copyClipboard(id) {
    ipcRenderer.send("island:clipboard-copy", String(id || ""));
  },
  writeClipboard(text) {
    ipcRenderer.send("island:clipboard-write", String(text || ""));
  },
  pinClipboard(id) {
    ipcRenderer.send("island:clipboard-pin", String(id || ""));
  },
  deleteClipboard(id) {
    ipcRenderer.send("island:clipboard-delete", String(id || ""));
  },
  clearClipboard() {
    ipcRenderer.send("island:clipboard-clear");
  },
  launchApp(id) {
    ipcRenderer.send("island:launch-app", String(id || ""));
  },
  removeLauncherApp(id) {
    ipcRenderer.send("island:launcher-remove", String(id || ""));
  },
  openPath(filePath) {
    ipcRenderer.send("island:open-path", String(filePath || ""));
  },
  revealPath(filePath) {
    ipcRenderer.send("island:reveal-path", String(filePath || ""));
  },
  openBluetooth() {
    ipcRenderer.send("island:bluetooth-open");
  },
  openNetwork() {
    ipcRenderer.send("island:network-open");
  },
  hideIsland() {
    ipcRenderer.send("island:hide");
  },
  quitApp() {
    ipcRenderer.send("island:quit");
  },
  removeActivity(id) {
    ipcRenderer.send("island:activity-remove", String(id || ""));
  },

  getClipboard: () => ipcRenderer.invoke("island:get-clipboard"),
  getLauncher: () => ipcRenderer.invoke("island:get-launcher"),
  addLauncherApp: () => ipcRenderer.invoke("island:launcher-add"),
  addLauncherUrl: (payload) => ipcRenderer.invoke("island:launcher-add-url", payload),
  getLyrics: (query) => ipcRenderer.invoke("island:lyrics", query),
  getActivities: () => ipcRenderer.invoke("island:get-activities"),
  addActivity: (payload) => ipcRenderer.invoke("island:activity-add", payload),
  getNotes: () => ipcRenderer.invoke("island:get-notes"),
  saveNotes: (value) => ipcRenderer.invoke("island:save-notes", String(value || "")),
  getSettings: () => ipcRenderer.invoke("island:get-settings"),
  saveSettings: (patch) => ipcRenderer.invoke("island:save-settings", patch),

  onBridgeState(callback) {
    return subscribe("island:bridge-state", callback);
  },
  onStats(callback) {
    return subscribe("island:stats", callback);
  },
  onNotification(callback) {
    return subscribe("island:notification", callback);
  },
  onCollapse(callback) {
    return subscribe("island:collapse", callback);
  },
  onTogglePanel(callback) {
    return subscribe("island:toggle-panel", callback);
  },
  onAppInfo(callback) {
    return subscribe("island:app-info", callback);
  },
  onRefreshLayout(callback) {
    return subscribe("island:refresh-layout", callback);
  },
  onOpenTab(callback) {
    return subscribe("island:open-tab", callback);
  },
  onFocusState(callback) {
    return subscribe("island:focus-state", callback);
  },
  onClipboard(callback) {
    return subscribe("island:clipboard", callback);
  },
  onLauncher(callback) {
    return subscribe("island:launcher-list", callback);
  },
  onActivities(callback) {
    return subscribe("island:activities", callback);
  },
  onFilesDropped(callback) {
    return subscribe("island:files-dropped", callback);
  },
  onResetDock(callback) {
    return subscribe("island:reset-dock", callback);
  },
});

/* Let the page receive OS file drops even though it is sandboxed. */
function forwardDroppedFiles(files) {
  const paths = [];
  for (const file of files || []) {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) paths.push(filePath);
    } catch {}
  }
  if (paths.length) ipcRenderer.send("island:files-dropped", paths);
}

window.addEventListener(
  "dragover",
  (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files")) {
      event.preventDefault();
    }
  },
  true
);

window.addEventListener(
  "drop",
  (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    forwardDroppedFiles(event.dataTransfer.files);
  },
  true
);
