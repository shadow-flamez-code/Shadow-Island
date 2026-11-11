"use strict";

/* Real-input probe: moves the OS mouse over the island pill (collapsed
   and expanded-edge zones), clicks, screenshots the desktop to prove
   whether clicks land while the window manages click-through. */
const { app, BrowserWindow, screen } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

app.disableHardwareAcceleration();

const CLICK_PS1 = String.raw`
param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
}
"@
[Mouse]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 700
[Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;

const SHOT_PS1 = (out) => `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${out}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;

async function runPs(command, timeout = 30000) {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(out + "\nTIMEOUT"); }, timeout);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 820,
    height: 660,
    show: true,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { preview: "compact" } });
  await new Promise((r) => setTimeout(r, 2800));

  const display = screen.getPrimaryDisplay();
  const wx = Math.round(display.workArea.x + (display.workArea.width - 820) / 2);
  const wy = Math.round(display.workArea.y);
  win.setPosition(wx, wy, false);
  const cx = wx + 410; // pill center x
  const cy = wy + 39; // pill center y

  const out = path.join(__dirname, "probe-click.png");
  const result = await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('#compact');
    const rect = pill.getBoundingClientRect();
    return JSON.stringify({ mode: pill.dataset.mode, w: Math.round(rect.width), left: Math.round(rect.left), top: Math.round(rect.top) });
  })()`);
  console.log("BEFORE:", result);

  // Move to the expanded-edge zone (outside collapsed pill, inside expanded).
  console.log("moving to", cx - 210, cy);
  await runPs(CLICK_PS1.replace("$X", String(cx - 210)).replace("$Y", String(cy)));
  await new Promise((r) => setTimeout(r, 700));
  await runPs(SHOT_PS1(out));
  const after = await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('#compact');
    const rect = pill.getBoundingClientRect();
    return JSON.stringify({ mode: pill.dataset.mode, w: Math.round(rect.width), opacity: getComputedStyle(pill).opacity, panelOpen: document.body.classList.contains('panel-open') });
  })()`);
  console.log("AFTER:", after);
  app.quit();
});
