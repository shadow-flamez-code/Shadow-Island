"use strict";

/* One-shot CDP evaluator for the running app: node tools-eval.js "<expression>" */
const expression = process.argv.slice(2).join(" ") || "1+1";

async function main() {
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = targets.find((target) => target.type === "page" && /index\.html/.test(target.url));
  if (!page) throw new Error("No page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const result = await new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    );
  });

  const value = result.result?.value;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  ws.close();
}

main().catch((error) => {
  console.error("EVAL failed:", error.message);
  process.exitCode = 1;
});
