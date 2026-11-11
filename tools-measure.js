"use strict";

/* Layout probe: prints panel/header/tab metrics for the preview shell. */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

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
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { preview: "system" },
  });
  await new Promise((r) => setTimeout(r, 2600));
  const data = await win.webContents.executeJavaScript(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return JSON.stringify({
      panel: box('#panel'),
      head: box('.panel-head'),
      brand: box('.brand'),
      logo: box('.brand-logo'),
      tabs: box('.tabs'),
      tab: box('.tab'),
      actions: box('.head-actions'),
      rail: box('.status-rail'),
      page: box('.page.is-active'),
      grid: box('.now-grid'),
    }, null, 2);
  })()`);
  require("node:fs").writeFileSync("measure-out.json", data);
  console.log("METRICS", data);
  const image = await win.webContents.capturePage();
  require("node:fs").writeFileSync("measure-system.png", image.toPNG());
  app.quit();
});
