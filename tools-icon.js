"use strict";

/* Assembles a multi-resolution Windows .ico from pre-rendered PNGs. */
const fs = require("node:fs");
const path = require("node:path");

const sizes = [16, 24, 32, 48, 64, 128, 256];
const buildDir = path.join(__dirname, ".iconbuild");
const pngs = sizes.map((size) => {
  const file = path.join(buildDir, `icon_${size}.png`);
  return { size, data: fs.readFileSync(file) };
});

const count = pngs.length;
const headerSize = 6;
const entrySize = 16;
const header = Buffer.alloc(headerSize + count * entrySize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: ICO
header.writeUInt16LE(count, 4);

let offset = headerSize + count * entrySize;
pngs.forEach((png, index) => {
  const entry = headerSize + index * entrySize;
  const sizeByte = png.size >= 256 ? 0 : png.size;
  header.writeUInt8(sizeByte, entry);
  header.writeUInt8(sizeByte, entry + 1);
  header.writeUInt8(0, entry + 2); // colors
  header.writeUInt8(0, entry + 3); // reserved
  header.writeUInt16LE(1, entry + 4); // planes
  header.writeUInt16LE(32, entry + 6); // bit count
  header.writeUInt32LE(png.data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.data.length;
});

const out = Buffer.concat([header, ...pngs.map((png) => png.data)]);
fs.writeFileSync(path.join(__dirname, "assets", "icon.ico"), out);
console.log(`icon.ico written (${out.length} bytes, ${count} sizes)`);
