/**
 * Minimal PNG codec for the bar tooling (no dependencies; node:zlib only).
 *
 * Decodes non-interlaced 8-bit greyscale, grey+alpha, RGB, and RGBA PNGs,
 * which covers the exemplar art and Electron/CDP captures. Encodes RGBA with
 * filter 0, which is enough for test fixtures and crops.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** An RGBA8 raster, row-major, top-left origin. */
export interface Image {
  width: number;
  height: number;
  /** width * height * 4 bytes. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bytes per pixel for each supported colour type at bit depth 8. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buf: Uint8Array): Image {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("png: bad signature");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = body[8];
      colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8) throw new Error(`png: bit depth ${String(depth)} unsupported`);
      if (CHANNELS[colorType] === undefined) throw new Error(`png: colour type ${String(colorType)} unsupported`);
      if (interlace !== 0) throw new Error("png: interlaced images unsupported");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (width === 0 || height === 0) throw new Error("png: missing IHDR");
  const bpp = CHANNELS[colorType]!;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error("png: truncated image data");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? px[dst + x - bpp]! : 0;
      const b = y > 0 ? px[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? px[prev + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + b;
          break;
        case 3:
          out = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`png: bad filter ${String(filter)} on row ${String(y)}`);
      }
      px[dst + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += bpp) {
    const o = i * 4;
    if (bpp === 1 || bpp === 2) {
      data[o] = data[o + 1] = data[o + 2] = px[j]!;
      data[o + 3] = bpp === 2 ? px[j + 1]! : 255;
    } else {
      data[o] = px[j]!;
      data[o + 1] = px[j + 1]!;
      data[o + 2] = px[j + 2]!;
      data[o + 3] = bpp === 4 ? px[j + 3]! : 255;
    }
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes an RGBA image (filter 0 on every row). Deterministic. */
export function encodePng(img: Image): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, img.width);
  v.setUint32(4, img.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = new Uint8Array((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A solid-colour RGBA image, for tests and synthetic fixtures. */
export function solidImage(width: number, height: number, rgb: readonly [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Paints a rectangle (clipped to the image) in place. */
export function fillRect(img: Image, rect: readonly [number, number, number, number], rgb: readonly [number, number, number]): void {
  const [x0, y0, w, h] = rect;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = 255;
    }
  }
}
