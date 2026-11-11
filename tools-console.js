"use strict";

/* Loads the renderer in preview mode and prints console errors/warnings. */
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
    if (level === "error" || level === "warning") {
      console.log(`[${level}]`, event.message);
    }
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { preview: tab },
  });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const state = await win.webContents.executeJavaScript(`(() => {
    const p = document.querySelector('#panel');
    const cs = getComputedStyle(p);
    const head = document.querySelector('.panel-head');
    const rail = document.querySelector('.status-rail');
    const page = document.querySelector('.page.is-active');
    const grid = document.querySelector('.settings-grid');
    const cards = [...document.querySelectorAll('.settings-card')].map((c) => {
      const r = c.getBoundingClientRect();
      return { t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) };
    });
    return JSON.stringify({
      bodyClass: document.body.className,
      panelOpen: document.body.classList.contains('panel-open'),
      clip: cs.clipPath,
      opacity: cs.opacity,
      head: head ? getComputedStyle(head).opacity : null,
      rail: rail ? getComputedStyle(rail).opacity : null,
      page: page ? { op: getComputedStyle(page).opacity, t: getComputedStyle(page).transform } : null,
      grid: grid ? { h: grid.clientHeight, sh: grid.scrollHeight, rows: getComputedStyle(grid).gridTemplateRows } : null,
      cards,
    });
  })()`);
  console.log("STATE", state);
  app.quit();
});
