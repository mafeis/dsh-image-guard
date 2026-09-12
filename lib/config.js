// lib/config.js — 配置文件读写（~/.dsh/image-guard.json）+ 默认值 + 校验 + 投影
//
// 与 dsh-net-proxy 同一套做法：配置落在 DSH_HOME 下的 JSON，支持热更，
// 设置页/命令行都改这一份，避免「patch 里一份、运行时另一份」的漂移。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_MARKER } from "./decide.js";
import { PATH_MODES } from "./shapes.js";

export function configPath() {
  // DSH_IMAGE_GUARD_CONFIG 是测试隔离口：否则存在的真实配置（文件优先于传入 config）
  // 会把单测结论悄悄带偏——实测被 ~/.dsh/image-guard.json 的 keepRecent=8 坑过一次。
  if (process.env.DSH_IMAGE_GUARD_CONFIG) return process.env.DSH_IMAGE_GUARD_CONFIG;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "image-guard.json");
}

export function defaults() {
  return {
    enabled: true,
    /** 保留最近几张图，其余换成占位文本 */
    keepRecent: 12,
    /** 上游因图片数量报 400 时的降级重试次数 */
    maxRetries: 3,
    /** 是否从 400 报文里学习服务端上限（学到后同进程内后续请求直接按上限-1 发） */
    learnLimit: true,
    /** 只观察不修改（用于先看清会裁掉什么，再决定要不要开） */
    dryRun: false,
    /** 命中哪些路径才处理 */
    matchPath: "/chat/completions|/messages",
    /** 被省略图片替换成什么（模板，支持 {index}/{name}/{path}/{id} 等占位符） */
    placeholder: DEFAULT_MARKER,
    /** 标记里显示多少路径：full 绝对路径 / relative 相对工作区或 ~ / basename 只文件名 / none 不显示 */
    pathMode: "basename",
    /** 估算"省下多少 token"用的每张图视觉 token 数（该路由实测上限 972；0 = 不估算） */
    tokensPerImage: 972,
    /** 打印日志 */
    verbose: true,
  };
}

const clampInt = (v, lo, hi, dft) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 宽松但明确的布尔归一化：接受 true/false、1/0、'true'/'off' 等，其余取默认值。
 *  （设置页传字符串、PUT 路由传 JSON 都不会再把 "no" 当成 true。） */
const boolOf = (v, dft) => {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off", ""].includes(s)) return false;
  }
  return dft;
};

/** 校验并归一化：脏配置绝不静默落盘，直接抛错（错误会被路由/日志展示）。 */
export function normalize(raw) {
  const d = defaults();
  const m = { ...d, ...(raw && typeof raw === "object" ? raw : {}) };
  const keepRecent = clampInt(m.keepRecent, 0, 999, d.keepRecent);
  const maxRetries = clampInt(m.maxRetries, 0, 10, d.maxRetries);
  const matchPath = String(m.matchPath || d.matchPath);
  try {
    new RegExp(matchPath);
  } catch {
    throw new Error(`image-guard: matchPath 不是合法正则: ${JSON.stringify(matchPath)}`);
  }
  return {
    enabled: boolOf(m.enabled, d.enabled),
    keepRecent,
    maxRetries,
    learnLimit: boolOf(m.learnLimit, d.learnLimit),
    dryRun: boolOf(m.dryRun, d.dryRun),
    matchPath,
    placeholder: typeof m.placeholder === "string" && m.placeholder ? m.placeholder : d.placeholder,
    pathMode: PATH_MODES.includes(m.pathMode) ? m.pathMode : d.pathMode,
    tokensPerImage: clampInt(m.tokensPerImage, 0, 100000, d.tokensPerImage),
    verbose: boolOf(m.verbose, d.verbose),
  };
}

export function loadConfig(file = configPath()) {
  try {
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 剥 BOM
      return normalize(JSON.parse(raw));
    }
  } catch (err) {
    console.error(`[image-guard] 读取配置失败（用默认值继续）${file}:`, err && err.message);
  }
  return normalize(null);
}

export function writeConfig(cfg, file = configPath()) {
  const normalized = normalize(cfg);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tmp, file); // 原子替换
  return normalized;
}
