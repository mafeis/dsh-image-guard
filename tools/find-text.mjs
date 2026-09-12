/**
 * 扫描所有 DSH 会话日志，找出包含指定文本的帧，并打印其真实时间。
 * 用法: node tools/find-text.mjs "At most 8 image" [--today]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = 0xfd2fb528;
const ROOT = (process.env.DSH_HOME || path.join(os.homedir(), ".dsh")).replace(/\\/g, "/") + "/sessions";

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

const pattern = process.argv[2] || "At most 8 image";
const todayOnly = process.argv.includes("--today");
const today = new Date().toDateString();

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.zstd$/.test(e.name)) files.push(p);
  }
})(ROOT);

let hits = 0;
for (const f of files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)) {
  const st = fs.statSync(f);
  if (todayOnly && new Date(st.mtimeMs).toDateString() !== today) continue;
  let frames;
  try { frames = splitFrames(fs.readFileSync(f)); } catch { continue; }
  const matched = [];
  frames.forEach((s, i) => {
    if (s.includes(pattern)) {
      const t = /"time":(\d{13})/.exec(s);
      matched.push({ i, at: t ? new Date(Number(t[1])).toLocaleString() : "?", snippet: s.slice(0, 150).replace(/\s+/g, " ") });
    }
  });
  if (matched.length) {
    hits += matched.length;
    console.log(`\n★ ${f.replace(ROOT + "\\", "")}  （改动 ${new Date(st.mtimeMs).toLocaleString()}，帧数 ${frames.length}）`);
    for (const m of matched) console.log(`   #${m.i}  ${m.at}\n      ${m.snippet}`);
  }
}
console.log(`\n合计命中 ${hits} 处（扫描 ${files.length} 个会话文件${todayOnly ? "，限今日改动" : ""}）`);
