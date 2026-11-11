"use strict";

/* Screenshot harness: loads the renderer in preview mode (mock API), paints an
   opaque backdrop so the compositor renders the artwork, waits for settle and
   captures.
   Usage: electron tools-shot.js <tab> <out.png> [settle-ms] [width] [height] */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const tab = process.argv[2] || "now";
const out = process.argv[3] || "preview.png";
const settle = Number(process.argv[4] || 4200);
const width = Number(process.argv[5] || 820);
const height = Number(process.argv[6] || 660);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: "#00000000",
    transparent: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { preview: tab, opaque: "1", ...(process.argv[7] ? { noActivities: "1" } : {}) },
  });
  await new Promise((resolve) => setTimeout(resolve, settle));
  await win.webContents.capturePage();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const image = await win.webContents.capturePage();
  require("node:fs").writeFileSync(out, image.toPNG());
  console.log(`SHOT ${out} (${tab})`);
  app.quit();
});
