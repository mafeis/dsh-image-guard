// lib/config.js — 配置文件读写（~/.dsh/image-guard.json）+ 默认值 + 校验 + 投影
//
// 与 dsh-net-proxy 同一套做法：配置落在 DSH_HOME 下的 JSON，支持热更，
// 设置页/命令行都改这一份，避免「patch 里一份、运行时另一份」的漂移。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PATH_MODES } from "./shapes.js";

export function configPath() {
  // DSH_IMAGE_GUARD_CONFIG 是测试隔离口：否则存在的真实配置（文件优先于传入 config）
  // 会把单测结论悄悄带偏——实测被 ~/.dsh/image-guard.json 的 keepRecent=8 坑过一次。
  if (process.env.DSH_IMAGE_GUARD_CONFIG) return process.env.DSH_IMAGE_GUARD_CONFIG;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "image-guard.json");
}

/** 宿主设置文件：界面语言（locale.preference）存在这里，只读，用来定标记语言的默认值。 */
export function settingsPath() {
  if (process.env.DSH_SETTINGS) return process.env.DSH_SETTINGS;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "settings.yaml");
}

export function defaults() {
  return {
    enabled: true,
    /** 保留最近几张图，其余替换为占位文本 */
    keepRecent: 12,
    /** 上游因图片数量返回 400 时的降级重试次数 */
    maxRetries: 3,
    /** 是否从 400 响应中解析服务端上限（学到后，同进程内后续请求按上限 − 1 发送） */
    learnLimit: true,
    /** 仅观察，不修改请求（用于先确认将被裁剪的图片，再决定是否启用） */
    dryRun: false,
    /** 命中哪些路径才处理 */
    matchPath: "/chat/completions|/messages",
    /** 被省略图片的替换内容（模板，支持 {index}/{name}/{path}/{id} 等占位符）；空 = 用生效标记语言的默认模板 */
    placeholder: "",
    /** 标记语言：zh 中文 / en 英文；空 = 跟随宿主界面语言（见 hostLocale） */
    markerLang: "",
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
    placeholder: typeof m.placeholder === "string" ? m.placeholder : d.placeholder,
    // 只认显式的 zh/en；其余（缺失、""、脏值）一律当作「跟随界面语言」
    markerLang: m.markerLang === "zh" || m.markerLang === "en" ? m.markerLang : "",
    pathMode: PATH_MODES.includes(m.pathMode) ? m.pathMode : d.pathMode,
    tokensPerImage: clampInt(m.tokensPerImage, 0, 100000, d.tokensPerImage),
    verbose: boolOf(m.verbose, d.verbose),
  };
}

let localeCache = { key: null, value: "zh", at: 0 };

/**
 * 宿主界面语言（settings.yaml 的 locale.preference）：en* → "en"，其余 → "zh"。
 * 解析不了（文件缺失/格式变化/无该键）按 "zh"，绝不抛错——默认语言不该让插件挂掉。
 * 按 mtime+size 缓存，避免每个请求都读盘。
 */
export function hostLocale(file = settingsPath()) {
  let key;
  try {
    const st = fs.statSync(file);
    key = `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "zh";
  }
  // 键（mtime+size）相同且 1 秒内视为命中：即使发生在同一毫秒的同尺寸重写，也最多脏 1 秒
  if (localeCache.key === key && Date.now() - localeCache.at < 1000) return localeCache.value;
  let value = "zh";
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let inLocale = false;
    for (const line of lines) {
      if (/^[A-Za-z0-9_.-]+\s*:/.test(line)) {
        inLocale = /^locale\s*:/.test(line.trim()); // 只认顶层 locale: 段
        continue;
      }
      if (!inLocale) continue;
      const m = /^\s+preference\s*:\s*["']?([A-Za-z0-9_-]+)/.exec(line);
      if (m) {
        value = /^en/i.test(m[1]) ? "en" : "zh";
        break;
      }
    }
  } catch {
    value = "zh";
  }
  localeCache = { key, value, at: Date.now() };
  return value;
}

/** 生效的标记语言：显式配置优先；未配置时跟随宿主界面语言。 */
export function effectiveMarkerLang(cfg) {
  const v = cfg && cfg.markerLang;
  if (v === "zh" || v === "en") return v;
  return hostLocale();
}

/** 给设置页/路由看的投影：把「跟随界面语言」解析成实际语言，并标明是否是跟随态。 */
export function viewConfig(cfg) {
  const c = normalize(cfg);
  return { ...c, markerLang: effectiveMarkerLang(c), markerLangAuto: !c.markerLang };
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
