/**
 * 读取 DSH 会话日志（追加式的多帧 zstd jsonl）。
 * Node 的 zstdDecompressSync 只解第一帧，这里按 zstd 帧结构逐帧剖开。
 * 用法: node tools/read-session.mjs <session文件> [--tail N] [--grep 关键词]
 *       node tools/read-session.mjs --list
 * 只输出结构化摘要，不打印 base64。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = 0xfd2fb528; // zstd frame magic，按小端读 u32

/** 把一个多帧 zstd 缓冲切成逐帧内容。 */
function splitFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 6 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) break; // 不再是帧头，停
    const desc = buf[off + 4];
    const fcsFlag = desc >> 6;
    const singleSegment = (desc >> 5) & 1;
    const hasChecksum = (desc >> 2) & 1;
    const dictIdFlag = desc & 3;
    let h = off + 5;
    if (!singleSegment) h += 1; // window descriptor
    h += [0, 1, 2, 4][dictIdFlag];
    if (fcsFlag === 0) {
      if (singleSegment) h += 1;
    } else if (fcsFlag === 1) h += 2;
    else if (fcsFlag === 2) h += 4;
    else h += 8;

    // 逐块头算帧尾：块头 3 字节，bit0=last，bit1-2=type，其余=size
    let p = h;
    let ok = false;
    let guard = 0;
    while (p + 3 <= buf.length && guard++ < 200000) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += 3;
      if (type === 3) break; // reserved，非法
      const dataLen = type === 0 ? size : type === 1 ? 1 : size; // Raw / RLE(1字节) / Compressed
      p += dataLen;
      if (p > buf.length) break;
      if (last) {
        ok = true;
        break;
      }
    }
    if (!ok) break;
    const end = p + (hasChecksum ? 4 : 0);
    if (end > buf.length) break;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(off, end)).toString("utf8"));
      off = end;
    } catch {
      break;
    }
  }
  return out;
}

const args = process.argv.slice(2);
const ROOT = (process.env.DSH_HOME || path.join(os.homedir(), ".dsh")).replace(/\\/g, "/") + "/sessions";

if (args[0] === "--list") {
  const rows = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.zstd$/.test(e.name)) rows.push(p);
    }
  })(ROOT);
  rows
    .map((p) => ({ p, mt: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)
    .slice(0, Number(args[1] || 10))
    .forEach(({ p, mt }) => console.log(`${new Date(mt).toLocaleString()}  ${(fs.statSync(p).size / 1024).toFixed(0)}KB  ${p.replace(ROOT + "\\", "")}`));
  process.exit(0);
}

const file = args[0];
const tailN = Number((args[args.indexOf("--tail") + 1] || 5)) || 5;
const grep = args.includes("--grep") ? args[args.indexOf("--grep") + 1] : null;
const buf = fs.readFileSync(file);
const frames = splitFrames(buf);
console.log(`${path.basename(path.dirname(file))}`);
console.log(`  压缩 ${(buf.length / 1024).toFixed(0)}KB → 帧数 ${frames.length}，总字符 ${frames.reduce((a, s) => a + s.length, 0)}`);
const imgs = frames.reduce((a, s) => a + (s.match(/"image_url"/g) || []).length, 0);
console.log(`  含 image_url 的片段合计 ${imgs}`);

if (grep) {
  console.log(`  —— 匹配 "${grep}" 的帧：`);
  frames.forEach((s, i) => {
    if (s.includes(grep)) console.log(`     #${i} len=${s.length}  ${s.slice(0, 260).replace(/\s+/g, " ")}`);
  });
}
console.log(`  —— 末 ${tailN} 帧：`);
frames.slice(-tailN).forEach((s, k) => {
  const i = frames.length - tailN + k;
  let t = null, role = null, ev = null;
  try {
    const j = JSON.parse(s);
    t = j.time ?? j.timestamp ?? j.createdAt ?? j.at ?? null;
    role = j.role ?? j.type ?? j.kind ?? null;
    ev = j.event ?? j.name ?? null;
  } catch {}
  const iso = typeof t === "number" ? new Date(t).toLocaleString() : t;
  console.log(`     #${i} t=${iso ?? "-"} role=${role ?? "-"} ev=${ev ?? "-"} len=${s.length}`);
  console.log(`        ${s.slice(0, 200).replace(/\s+/g, " ")}`);
});
