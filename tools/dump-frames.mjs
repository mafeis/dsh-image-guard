/**
 * 打印指定会话文件的指定帧原文（不打印 base64）。
 * 用法: node tools/dump-frames.mjs <session文件> 713,715,720,724 [--max 1500]
 */
import fs from "node:fs";
import zlib from "node:zlib";

const MAGIC = 0xfd2fb528;

function splitFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 6 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) break;
    const desc = buf[off + 4];
    const singleSegment = (desc >> 5) & 1;
    const hasChecksum = (desc >> 2) & 1;
    let h = off + 5;
    if (!singleSegment) h += 1;
    h += [0, 1, 2, 4][desc & 3];
    const fcs = desc >> 6;
    h += fcs === 0 ? (singleSegment ? 1 : 0) : fcs === 1 ? 2 : fcs === 2 ? 4 : 8;
    let p = h;
    let ok = false;
    let guard = 0;
    while (p + 3 <= buf.length && guard++ < 200000) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += 3;
      if (type === 3) break;
      p += type === 0 ? size : type === 1 ? 1 : size;
      if (p > buf.length) break;
      if (last) { ok = true; break; }
    }
    if (!ok) break;
    const end = p + (hasChecksum ? 4 : 0);
    if (end > buf.length) break;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(off, end)).toString("utf8"));
      off = end;
    } catch { break; }
  }
  return out;
}

const file = process.argv[2];
const idx = (process.argv[3] || "").split(",").map(Number).filter((n) => !Number.isNaN(n));
const max = Number((process.argv[process.argv.indexOf("--max") + 1] || 1200)) || 1200;

const frames = splitFrames(fs.readFileSync(file));
console.log(`帧总数 ${frames.length}\n`);
for (const i of idx) {
  const s = frames[i];
  if (!s) { console.log(`#${i} 不存在`); continue; }
  console.log("=".repeat(90));
  console.log(`#${i}  len=${s.length}`);
  console.log("=".repeat(90));
  // 把 stream 里的 chunk 拆开逐一打印，便于看错误
  try {
    const j = JSON.parse(s);
    const stream = j?.data?.stream;
    if (Array.isArray(stream)) {
      for (const ev of stream) {
        const t = ev.chunk?.type ?? ev.type;
        const body = JSON.stringify(ev.chunk ?? ev);
        console.log(`  [${t}] ${body.length > max ? body.slice(0, max) + " …" : body}`);
      }
    } else {
      const body = JSON.stringify(j);
      console.log(body.length > max * 3 ? body.slice(0, max * 3) + " …" : body);
    }
  } catch {
    console.log(s.slice(0, max * 3));
  }
  console.log("");
}
