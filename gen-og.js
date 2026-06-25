// Genera public/og-image.png — 1200x630, bandera Venezuela + texto
// Solo usa Node.js builtins (zlib). Ejecutar: node gen-og.js
const zlib = require('zlib');
const fs   = require('fs');

const W = 1200, H = 630;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// Build raw image: Venezuela flag stripes (amarillo / azul / rojo) + dark overlay + text
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    let r, g, b;
    const third = H / 3;
    if (y < third) {
      // amarillo
      r = 207; g = 160; b = 32;
    } else if (y < third * 2) {
      // azul
      r = 0;   g = 56;  b = 168;
    } else {
      // rojo
      r = 207; g = 16;  b = 16;
    }
    // oscurecer centro para legibilidad del texto
    const cx = Math.abs(x - W / 2) / (W / 2);
    const cy = Math.abs(y - H / 2) / (H / 2);
    const dim = 0.45 + 0.35 * Math.max(cx, cy);
    r = Math.round(r * dim); g = Math.round(g * dim); b = Math.round(b * dim);

    const off = y * (W * 3 + 1) + 1 + x * 3;
    raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0))
]);

fs.writeFileSync('public/og-image.png', png);
console.log('✅ public/og-image.png generado:', Math.round(png.length / 1024), 'KB');
