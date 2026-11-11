"use strict";

/* Entry point: picks the real preload bridge or the preview mock and boots. */
(() => {
  const DI = window.DI;
  const params = new URLSearchParams(window.location.search);
  const preview = params.get("preview");
  DI.isPreview = preview !== null;
  DI.previewTab = ["now", "system", "tools", "live", "link", "settings"].includes(preview) ? preview : "now";
  if (preview === "idle") {
    DI.previewTab = "now";
    DI.mockIdle = true;
  }

  document.body.classList.toggle("is-preview", DI.isPreview);
  if (params.get("light") === "1") {
    document.body.classList.add("light");
    DI.forcedLight = true;
  }
  DI.api = DI.isPreview ? DI.createMockApi() : window.islandAPI;

  if (!DI.api) {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100%;font-family:sans-serif;color:#fff;background:#0a0a12">' +
      "<p>Island bridge unavailable. Launch this window through Electron.</p></div>";
    return;
  }

  if (DI.api.__files) {
    DI.state.files = DI.api.__files.map((item) => ({ ...item }));
  }

  for (const init of DI.inits) {
    try {
      init();
    } catch (error) {
      console.error("Renderer module failed to initialise:", error);
    }
  }

  DI.initCore();

  if (DI.isPreview) {
    if (preview === "split") {
      DI.setSplit(true);
    } else if (preview !== "compact" && preview !== "idle") {
      setTimeout(() => DI.openPanel(DI.previewTab), 140);
    }
  }
})();
