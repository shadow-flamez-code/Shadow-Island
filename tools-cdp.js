"use strict";

/* Connects to the running app over CDP, reloads once, and reports console
   errors plus the compact pill's live DOM metrics. */
const targetsUrl = "http://127.0.0.1:9222/json/list";

async function main() {
  const targets = await (await fetch(targetsUrl)).json();
  const page = targets.find((target) => target.type === "page" && /index\.html/.test(target.url)) || targets.find((target) => target.type === "page");
  if (!page) throw new Error("No page target");
  console.log("target", page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      ws.send(JSON.stringify({ id: callId, method, params }));
    });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      events.push("EXCEPTION " + JSON.stringify(msg.params.exceptionDetails).slice(0, 700));
    }
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      events.push(
        "CONSOLE " + msg.params.type + " " +
        msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 500)
      );
    }
    if (msg.method === "Log.entryAdded") {
      const entry = msg.params.entry;
      if (entry.level === "error" || entry.level === "warning") {
        events.push("LOG " + entry.level + " " + entry.text.slice(0, 500));
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 4500));

  const result = await send("Runtime.evaluate", {
    expression: `(() => {
      const pill = document.querySelector('#compact');
      const rect = pill?.getBoundingClientRect();
      const style = pill ? getComputedStyle(pill) : null;
      return JSON.stringify({
        body: document.body.className,
        readyState: document.readyState,
        pill: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        pillStyle: style ? { opacity: style.opacity, visibility: style.visibility, display: style.display, background: style.backgroundColor } : null,
        title: document.querySelector('#compactTitle')?.textContent,
        artist: document.querySelector('#compactArtist')?.textContent,
        mode: pill?.dataset.mode,
        panelOpen: document.body.classList.contains('panel-open'),
        services: [...document.querySelectorAll('.rail-svc')].map((node) => node.className),
        stats: document.querySelector('#cpuValue')?.textContent,
        mediaCard: document.querySelector('#trackTitle')?.textContent,
      });
    })()`,
    returnByValue: true,
  });

  console.log("STATE", result.result.value);
  console.log("EVENTS", events.length ? events.join("\n") : "none");
  ws.close();
}

main().catch((error) => {
  console.error("CDP failed:", error.message);
  process.exitCode = 1;
});
