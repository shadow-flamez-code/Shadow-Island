"use strict";
const fs = require("node:fs");
const raw = fs.readFileSync("package.json", "utf8");
const idx = raw.indexOf('"win"');
console.log("total bytes", raw.length, "win at", idx);
console.log(JSON.stringify(raw.slice(idx - 40, idx + 600)));
