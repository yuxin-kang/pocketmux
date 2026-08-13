import { deflateSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconSourceRoot = path.join(root, 'src-tauri', 'icon-source');
const androidIconRoot = path.join(root, 'src-tauri', 'icons', 'android');
const layerScale = 0.8;
const densitySizes = new Map([
  ['mdpi', 108],
  ['hdpi', 162],
  ['xhdpi', 216],
  ['xxhdpi', 324],
  ['xxxhdpi', 432],
]);

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function decodeRgbaPng(buffer) {
  const chunks = [];
  const idat = [];
  let width;
  let height;

  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (![...data.subarray(8, 13)].every((value, index) => value === [8, 6, 0, 0, 0][index])) {
        throw new Error('Android icon layers must be non-interlaced 8-bit RGBA PNG files');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (!['IEND', 'PLTE', 'tRNS'].includes(type)) {
      chunks.push({ type, data });
    }
    offset += length + 12;
  }

  if (!width || !height || idat.length === 0) throw new Error('Invalid PNG layer');
  const stride = width * 4;
  const encoded = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor];
    cursor += 1;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paethPredictor(left, up, upLeft)][filter];
      if (predictor === undefined) throw new Error(`Unsupported PNG filter ${filter}`);
      row[x] = (encoded[cursor + x] + predictor) & 0xff;
    }
    cursor += stride;
    previous = row;
  }

  return { width, height, pixels, chunks };
}

const crcTable = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), data.length + 8);
  return result;
}

function encodeRgbaPng({ width, height, pixels }) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(scanlines, (y * (stride + 1)) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function scaleCentered(image, scale) {
  const targetWidth = Math.round(image.width * scale);
  const targetHeight = Math.round(image.height * scale);
  const offsetX = Math.floor((image.width - targetWidth) / 2);
  const offsetY = Math.floor((image.height - targetHeight) / 2);
  const pixels = Buffer.alloc(image.pixels.length);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
      const sourceOffset = ((sourceY * image.width) + sourceX) * 4;
      const targetOffset = ((((offsetY + y) * image.width) + offsetX + x) * 4);
      image.pixels.copy(pixels, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }

  return { width: image.width, height: image.height, pixels };
}

function resizeNearest(image, targetSize) {
  const pixels = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / targetSize));
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / targetSize));
      const sourceOffset = ((sourceY * image.width) + sourceX) * 4;
      const targetOffset = ((y * targetSize) + x) * 4;
      image.pixels.copy(pixels, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { width: targetSize, height: targetSize, pixels };
}

for (const name of ['foreground', 'monochrome']) {
  const source = await readFile(path.join(iconSourceRoot, `pocketmux-android-${name}-base.png`));
  const prepared = scaleCentered(decodeRgbaPng(source), layerScale);
  await writeFile(path.join(iconSourceRoot, `pocketmux-android-${name}-layer.png`), encodeRgbaPng(prepared));
  for (const [density, size] of densitySizes) {
    const densityRoot = path.join(androidIconRoot, `mipmap-${density}`);
    await mkdir(densityRoot, { recursive: true });
    await writeFile(path.join(densityRoot, `ic_launcher_${name}.png`), encodeRgbaPng(resizeNearest(prepared, size)));
  }
}
