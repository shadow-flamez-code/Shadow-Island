"use strict";

/* Screenshot harness: loads the renderer in preview mode (mock API),
   waits for settle, captures, quits. Usage: electron tools-shot.js <tab> <out> */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const tab = process.argv[2] || "now";
const out = process.argv[3] || "preview.png";
const extraQuery = process.argv[4] || "";

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
    query: { preview: tab, ...(extraQuery ? Object.fromEntries(extraQuery.split("&").map((part) => part.split("="))) : {}) },
  });
  await new Promise((resolve) => setTimeout(resolve, 3600));
  const image = await win.webContents.capturePage();
  require("node:fs").writeFileSync(out, image.toPNG());
  console.log(`SHOT ${out} (${tab})`);
  app.quit();
});
