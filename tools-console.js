"use strict";

/* Loads the renderer in preview mode and prints console errors plus a small
   state dump. Usage: electron tools-console.js <tab> */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const tab = process.argv[2] || "settings";

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 820,
    height: 660,
    show: false,
    backgroundColor: "#00000000",
    transparent: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.on("console-message", (event) => {
    const level = event.level ?? "";
    if (level === "error" || level === "warning") console.log(`[${level}]`, event.message);
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { preview: tab },
  });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const state = await win.webContents.executeJavaScript(`(() => {
    const p = document.querySelector('#compact');
    const clock = document.querySelector('#compactIdleTime');
    const art = document.querySelector('#compactArtImg');
    const meta = document.querySelector('#compactMeta');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return JSON.stringify({
      mode: p?.dataset.mode,
      modeClasses: p?.className,
      clockHtml: clock ? clock.innerHTML.slice(0, 120) : null,
      clockOpacity: cs(clock)?.opacity,
      clockText: clock?.textContent,
      artSrc: art?.getAttribute('src')?.slice(0, 40),
      artClasses: art?.className,
      metaOpacity: cs(meta)?.opacity,
      title: document.querySelector('#compactTitle')?.textContent,
      idleDisplay: cs(document.querySelector('#compactIdle'))?.display,
      media: DI.state.bridge.media?.title,
      mockIdle: DI.mockIdle,
    });
  })()`);
  console.log("STATE", state);
  app.quit();
});
