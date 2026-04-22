/**
 * Generate a multi-size ICO file with BMP entries for rcedit compatibility.
 * Sizes: 16, 32, 48, 64, 128, 256
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPixelData(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const S = size;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      const scale = S / 256;

      // Rounded rectangle
      const margin = Math.round(8 * scale);
      const radius = Math.round(40 * scale);
      const inRect = x >= margin && x < S - margin && y >= margin && y < S - margin;
      let inRounded = inRect;
      if (inRect) {
        const cr = [
          [margin + radius, margin + radius],
          [S - margin - radius, margin + radius],
          [margin + radius, S - margin - radius],
          [S - margin - radius, S - margin - radius],
        ];
        for (const [cx, cy] of cr) {
          const zone =
            (x < margin + radius && y < margin + radius) ||
            (x > S - margin - radius && y < margin + radius) ||
            (x < margin + radius && y > S - margin - radius) ||
            (x > S - margin - radius && y > S - margin - radius);
          if (zone && Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) > radius) inRounded = false;
        }
      }

      if (!inRounded) {
        pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0;
        continue;
      }

      let r = 12, g = 16, b = 24, a = 255;

      // Border
      const bw = Math.max(2, Math.round(3 * scale));
      const bx = x - margin, by = y - margin, bWid = S - 2 * margin;
      if (bx < bw || bx >= bWid - bw || by < bw || by >= bWid - bw) {
        r = 0; g = 230; b = 118;
      }

      // "B" letter
      const lSize = Math.round(80 * scale);
      const lX = S / 2 - lSize / 2, lY = S / 2 - lSize / 2 - Math.round(20 * scale);
      const lx = x - lX, ly = y - lY;
      if (lx >= 0 && lx < lSize && ly >= 0 && ly < lSize) {
        const thick = Math.max(2, Math.round(14 * scale));
        const isV = lx < thick;
        const isT = ly < thick && lx < lSize * 0.75;
        const isM = ly >= lSize / 2 - thick / 2 && ly < lSize / 2 + thick / 2 && lx < lSize * 0.7;
        const isB = ly >= lSize - thick && lx < lSize * 0.75;
        const td = Math.sqrt((lx - lSize * 0.55) ** 2 + (ly - lSize * 0.25) ** 2);
        const isTB = td > lSize * 0.28 - thick && td < lSize * 0.28 + thick / 2 && lx > lSize * 0.3 && ly > 0 && ly < lSize / 2;
        const bd = Math.sqrt((lx - lSize * 0.55) ** 2 + (ly - lSize * 0.75) ** 2);
        const isBB = bd > lSize * 0.28 - thick && bd < lSize * 0.28 + thick / 2 && lx > lSize * 0.3 && ly > lSize / 2 && ly < lSize;
        if (isV || isT || isM || isB || isTB || isBB) { r = 0; g = 230; b = 118; }
      }

      // Chart line
      const chartY = S - margin - Math.round(50 * scale);
      const pts = [[50, 0], [80, -15], [110, -5], [140, -25], [170, -10], [200, -30]].map(([px, py]) => [Math.round(px * scale), Math.round(py * scale)]);
      for (let i = 0; i < pts.length - 1; i++) {
        if (x >= pts[i][0] && x <= pts[i + 1][0]) {
          const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
          const lineY = chartY + pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          if (Math.abs(y - lineY) < Math.max(1.5, 2.5 * scale)) { r = 0; g = 230; b = 118; }
        }
      }

      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = a;
    }
  }
  return pixels;
}

// Encode PNG for 256x256 entry
function encodePNG(pixels, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type, data) {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
    const combined = Buffer.concat([tb, data]);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(combined) >>> 0, 0);
    return Buffer.concat([lb, combined, cb]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// BMP DIB for smaller sizes
function createBmpEntry(pixels, size) {
  // BITMAPINFOHEADER (40 bytes) + pixel data (BGRA bottom-up) + AND mask
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // double height for ICO
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const imgSize = size * size * 4;
  header.writeUInt32LE(imgSize, 20);

  const bmpPixels = Buffer.alloc(imgSize);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4; // bottom-up
      bmpPixels[dst] = pixels[src + 2];     // B
      bmpPixels[dst + 1] = pixels[src + 1]; // G
      bmpPixels[dst + 2] = pixels[src];     // R
      bmpPixels[dst + 3] = pixels[src + 3]; // A
    }
  }

  const andMaskRow = Math.ceil(size / 8);
  const andMaskRowPadded = Math.ceil(andMaskRow / 4) * 4;
  const andMask = Buffer.alloc(andMaskRowPadded * size);

  return Buffer.concat([header, bmpPixels, andMask]);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Build multi-size ICO
const sizes = [16, 32, 48, 64, 128, 256];
const entries = [];

for (const size of sizes) {
  const pixels = createPixelData(size);
  if (size === 256) {
    entries.push({ size, data: encodePNG(pixels, size, size) });
  } else {
    entries.push({ size, data: createBmpEntry(pixels, size) });
  }
}

// ICO file format
const numImages = entries.length;
const headerSize = 6;
const dirSize = 16 * numImages;
let offset = headerSize + dirSize;

const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(numImages, 4);

const dirEntries = [];
for (const e of entries) {
  const dir = Buffer.alloc(16);
  dir.writeUInt8(e.size < 256 ? e.size : 0, 0);
  dir.writeUInt8(e.size < 256 ? e.size : 0, 1);
  dir.writeUInt8(0, 2);
  dir.writeUInt8(0, 3);
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(e.data.length, 8);
  dir.writeUInt32LE(offset, 12);
  offset += e.data.length;
  dirEntries.push(dir);
}

const ico = Buffer.concat([header, ...dirEntries, ...entries.map(e => e.data)]);

const icoPath = path.join(__dirname, '..', 'public', 'icons', 'icon.ico');
const pngPath = path.join(__dirname, '..', 'public', 'icons', 'icon.png');
fs.writeFileSync(icoPath, ico);

// Save 256x256 PNG separately
const png256 = encodePNG(createPixelData(256), 256, 256);
fs.writeFileSync(pngPath, png256);

console.log(`ICO generated: ${icoPath} (${ico.length} bytes, ${numImages} sizes: ${sizes.join(', ')})`);
console.log(`PNG generated: ${pngPath} (${png256.length} bytes)`);
