// lib/shapes.js — 请求形态判定与图片裁剪（纯函数，无 IO，可单测）
//
// ⚠️ 本文件的核心纪律：【一律鸭子类型，绝不用 instanceof】
// 宿主把 LLM 请求以 Request 对象交给 fetch，而那个 Request 可能来自另一个 realm
// （Electron / undici 自带的类），此时 `input instanceof Request` 为 false。
// 踩过的坑：用 instanceof 判断 method → 跨 realm 失败 → method 被当成 "GET"
// → `method !== "POST"` → 整条请求被跳过、不裁剪 → 上游回 400。
// 参照实现：dsh-net-proxy 的 lib/proxy/request.js。

import { createHash } from "node:crypto";
import os from "node:os";

/** 路径显示策略：full=完整绝对路径 / relative=尽量相对（工作区或 ~）/ basename=只留文件名 / none=不显示 */
export const PATH_MODES = ["full", "relative", "basename", "none"];

/** 把绝对路径降到「不泄露本机结构」的形态：优先相对工作区，其次 ~，都不在就只留文件名。 */
export function relativizePath(p) {
  if (!p) return "";
  const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(p);
  const roots = [
    [norm(process.cwd()), ""],
    [norm(os.homedir()), "~"],
  ];
  for (const [root, prefix] of roots) {
    if (root && (target === root || target.startsWith(root + "/"))) {
      const rest = target.slice(root.length).replace(/^\//, "");
      return prefix ? prefix + "/" + rest : rest;
    }
  }
  return baseName(p); // 无法相对化 → 只留文件名（宁可少给，也不泄露任意绝对路径）
}

export function urlOf(input) {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return "";
}

/** 同 realm 的 Request。 */
export function isRequest(input) {
  return typeof Request !== "undefined" && input instanceof Request;
}

/** 跨 realm 的 Request（鸭子类型）。 */
export function looksLikeRequest(x) {
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.url === "string" &&
    typeof x.clone === "function" &&
    typeof x.text === "function"
  );
}

/** 取 HTTP 方法：init 优先，其次 input 自带（可能是跨 realm 的 Request），最后 GET。 */
export function methodOf(input, init) {
  const m = init?.method || (input && typeof input.method === "string" ? input.method : "GET");
  return String(m).toUpperCase();
}

/** 请求体形态（只给类型名，不读内容）。 */
export function bodyKindOf(init) {
  const b = init?.body;
  if (b == null) return "none";
  if (typeof b === "string") return "string";
  if (b instanceof Uint8Array) return "uint8array";
  if (b instanceof ArrayBuffer) return "arraybuffer";
  if (typeof ReadableStream !== "undefined" && b instanceof ReadableStream) return "ReadableStream";
  if (typeof b.getReader === "function") return "stream-like";
  if (typeof Blob !== "undefined" && b instanceof Blob) return "Blob";
  if (typeof FormData !== "undefined" && b instanceof FormData) return "FormData";
  return "other:" + (b?.constructor?.name ?? typeof b);
}

/** 入参形态（供诊断）。 */
export function inputKindOf(input) {
  if (typeof input === "string") return "url-string";
  if (typeof URL !== "undefined" && input instanceof URL) return "URL";
  if (isRequest(input)) return "Request";
  if (looksLikeRequest(input)) return "foreign-Request(" + (input.constructor?.name ?? "?") + ")";
  if (input && typeof input === "object") return "obj:" + (input.constructor?.name ?? "?");
  return typeof input;
}

/** 把 body 读成文本：init.body 优先，其次 Request 自带的体。读不到返回 null（调用方应原样放行）。 */
export async function readBodyText(input, init) {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array) return Buffer.from(b).toString("utf8");
  if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b)).toString("utf8");
  if (looksLikeRequest(input)) {
    try {
      const c = input.clone();
      return typeof c.text === "function" ? await c.text() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 替换请求体。
 * Request 形态**不自建 Request**（跨 realm 构造会炸），而是走 (input, init) 覆写——
 * 标准 fetch 语义里 init.body 会覆盖 input 自带的 body，dsh-net-proxy 也是从 init 取 body。
 */
export function withBody(input, init, text) {
  const base = { ...(init || {}) };
  if (looksLikeRequest(input) && !base.method && typeof input.method === "string") base.method = input.method;
  base.body = text;
  return [input, base];
}

export function isImagePart(p) {
  if (!p || typeof p !== "object") return false;
  const t = p.type;
  if (t === "image_url" || t === "image" || t === "input_image") return true;
  if (p.image_url && typeof p.image_url === "object") return true;
  if (p.source && typeof p.source === "object" && p.source.type) return true;
  return false;
}

/**
 * 收集所有图片片段的**位置路径**，按出现顺序（旧 → 新）。
 *
 * 为什么返回路径而不是 {mi,pi}：图片可能嵌在 `tool-result` 里再套一层 `content`
 * （DSH 自己的 `contentHasImage` 同样递归处理）。仅扫描一层会导致**既统计不到也无法裁剪**，
 * 表现为插件已加载但请求仍持续返回 400。因此这里递归遍历，路径形如
 * `["messages",3,"content",1]` 或 `["messages",5,"content",0,"content",2]`。
 */
export function collectImages(body) {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], path.concat(i));
      return;
    }
    if (!node || typeof node !== "object") return;
    if (isImagePart(node)) {
      out.push(path); // 图片片段本身不再深入
      return;
    }
    if (Array.isArray(node.content)) walk(node.content, path.concat("content"));
    if (Array.isArray(node.parts)) walk(node.parts, path.concat("parts"));
  };
  if (body && Array.isArray(body.messages)) walk(body.messages, ["messages"]);
  return out;
}

/** 前 8 个 content 片段类型（诊断用，确认图片在 body 里的真实形状）。 */
export function partTypeSample(body) {
  const out = [];
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return out;
  for (const m of msgs) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content) {
      const t = p?.type ?? (p?.image_url ? "image_url(无type)" : typeof p);
      out.push(t + (p?.image_url?.url ? "(有url)" : "") + (p?.text ? "(text)" : ""));
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** 深拷贝并把除「最近 keep 张」以外的图片替换为**带身份信息的标记**（不改原对象）。
 *
 * 关键点：标记必须让模型/agent 知道「省略了哪张、如何取回」。
 * DSH 的图片在消息里是成对出现的：
 *   {type:"text", text:"<path>D:\...\01-race-start.png</path><content>image/png image, 1280x720 px, 633106 bytes</content>"}
 *   {type:"image", attachment:{attachmentId:"sha256:…", name:"01-race-start.png", width:1280, height:720, bytes:633106}}
 * 请求体里则被展开成 {type:"image_url", image_url:{url:"data:image/png;base64,…"}}。
 * 于是标记优先取：旁边 text 片段里的 <path>/文件名/尺寸 → 远端 URL → 内联图的 sha1 指纹。
 */
export function stripImages(body, keep, template, opts = {}) {
  const clone = structuredClone(body);
  if (!Array.isArray(clone?.messages)) return { payload: clone, dropped: 0 };

  const all = collectImages(clone); // 路径形式，旧 → 新（含嵌套）
  const dropped = all.length - Math.max(0, keep);
  if (dropped <= 0) return { payload: clone, dropped: 0 };

  for (let i = 0; i < dropped; i++) {
    const path = all[i]; // 越靠前越旧：丢最早的
    const parent = atPath(clone, path.slice(0, -1));
    const pi = path[path.length - 1];
    if (!Array.isArray(parent)) continue;
    const info = extractImageInfo(parent[pi], parent, pi, {
      index: i + 1,
      total: all.length,
      kept: Math.max(0, keep),
      pathMode: opts.pathMode,
    });
    parent[pi] = { type: "text", text: renderMarker(info, template) };
  }
  return { payload: clone, dropped };
}

/** 按路径取值 / 赋值（路径由 collectImages 给出，如 ["messages",3,"content",1]）。 */
export function atPath(root, path) {
  let n = root;
  for (const k of path) {
    if (n == null) return undefined;
    n = n[k];
  }
  return n;
}

const IMG_EXT = "png|jpe?g|webp|gif|bmp|avif|svg";
const sha1short = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const baseName = (p) => String(p || "").split(/[\\/]/).pop() || "";

/**
 * 抽出一张图片的「身份」：名字 / 路径 / 远端地址 / 指纹 / 类型 / 尺寸 / 大小。
 * @param {any} part 该图片片段
 * @param {any[]} content 同一条消息的 content 数组（用于找 <path> 等线索）
 * @param {number} pi 该片段在 content 中的下标
 */
export function extractImageInfo(part, content, pi, ctx = {}) {
  const att = part?.attachment && typeof part.attachment === "object" ? part.attachment : null;
  const url =
    (typeof part?.image_url === "string" ? part.image_url : "") ||
    part?.image_url?.url ||
    part?.source?.url ||
    part?.source?.data ||
    "";
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);

  let mime = att?.mediaType || part?.source?.media_type || (dataUrl ? dataUrl[1] : "");
  let id = typeof att?.attachmentId === "string" ? att.attachmentId : "";
  let bytes = Number.isFinite(att?.bytes) ? att.bytes : null;
  let dims = att?.width && att?.height ? att.width + "x" + att.height : "";
  let name = typeof att?.name === "string" ? att.name : "";
  let path = "";
  let remote = "";

  if (dataUrl) {
    if (bytes == null) bytes = Math.round((dataUrl[2].length * 3) / 4);
    // 用「前 4KB + 总长」做指纹：同一张图每次请求都得到同一个 id（前缀缓存友好），且不必哈希整段 base64
    if (!id) id = "sha1:" + sha1short(dataUrl[2].slice(0, 4096) + "|" + dataUrl[2].length);
  } else if (/^https?:\/\//i.test(url)) {
    remote = url;
  } else if (/^file:\/\//i.test(url)) {
    path = decodeURIComponent(url.replace(/^file:\/\//i, ""));
  }

  // 兄弟文本片段里的线索：DSH 惯例是「图片前一个 text 片段带 <path> 与尺寸」
  const scan = (seq) => {
    for (const t of seq) {
      const s = typeof t === "string" ? t : typeof t?.text === "string" ? t.text : "";
      if (!s) continue;
      if (!path) {
        const m =
          /<path>\s*([^<]+?)\s*<\/path>/i.exec(s) ||
          new RegExp("([A-Za-z]:\\\\[^\\s<>\"'|]+\\.(?:" + IMG_EXT + "))", "i").exec(s) ||
          new RegExp("(/(?:[^\\s<>\"'|]+/)*[^\\s<>\"'|]+\\.(?:" + IMG_EXT + "))", "i").exec(s);
        if (m) path = m[1].trim();
      }
      if (!name) {
        const m = new RegExp("([\\w.@+-]+\\.(?:" + IMG_EXT + "))", "i").exec(s);
        if (m) name = m[1];
      }
      if (!dims) {
        const m = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(s);
        if (m) dims = m[1] + "x" + m[2];
      }
      if (bytes == null) {
        const m = /([\d,]{3,})\s*bytes/i.exec(s);
        if (m) bytes = Number(m[1].replace(/,/g, ""));
      }
      if (!mime) {
        const m = /(image\/[a-z0-9.+-]+)/i.exec(s);
        if (m) mime = m[1];
      }
    }
  };
  if (Array.isArray(content)) {
    scan(content.slice(0, pi).reverse()); // 先看前面的（更可能是它的说明）
    scan(content.slice(pi + 1));
  }
  if (!name && path) name = baseName(path);
  if (!name && remote) name = baseName(remote.split("?")[0]);

  // ⚠️ 隐私闸：标记是**发到（可能是第三方的）服务端**的内容，默认不把本机目录结构送出去。
  //   full=完整路径 / relative=尽量相对 / basename=只文件名 / none=连文件名都不给，只留指纹
  const mode = PATH_MODES.includes(ctx.pathMode) ? ctx.pathMode : "basename";
  const fullPath = path;
  if (mode === "none") {
    path = "";
    name = "";
  } else if (mode === "basename") path = baseName(path);
  else if (mode === "relative") path = relativizePath(path);

  const sizeText = bytes
    ? bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + " MiB"
      : bytes < 10240
        ? (bytes / 1024).toFixed(1) + " KiB"
        : Math.round(bytes / 1024) + " KiB"
    : "";
  const inline = [mime, dims, sizeText].filter(Boolean).join(" ");

  // identity：给模型看的一句话身份。有路径/地址就优先给可定位的那个；只有内联数据时给指纹+规格。
  let label;
  if (path) label = name && baseName(path) !== name ? name + " · " + path : path;
  else if (remote) label = name && !remote.endsWith(name) ? name + " · " + remote : remote;
  else label = (name ? name + " · " : "") + (mode === "none" && fullPath ? "图片 " : "内联图片 ") + (id || "?") + (inline ? " (" + inline + ")" : "");

  return {
    index: ctx.index ?? 1,
    total: ctx.total ?? 1,
    kept: ctx.kept,
    name,
    path,
    remote,
    id,
    mime,
    dims,
    sizeText,
    /** 形如 " · 名 · 路径"，可直接串进模板（为空串时不产生多余分隔符） */
    identity: label ? " · " + label : "",
    /** 让 agent 知道怎么把它拿回来；拿不回来就明说，避免它凭记忆瞎猜 */
    hint: path
      ? mode === "basename"
        ? " · 需要时按文件名在工作区内搜索后读取"
        : " · 需要时用 read_image 重新读取"
      : mode === "none" && fullPath
        ? " · 路径已按配置隐去"
        : remote
          ? " · 需要时可重新访问该地址"
          : " · 无原文件路径，已无法取回",
  };
}

/** 用模板渲染标记。模板不含 `{...}` 时原样返回（兼容将标记写死的旧配置）。 */
export function renderMarker(info, template) {
  const tpl = typeof template === "string" && template ? template : "[图片已省略 #{index}{identity}{hint}]";
  const map = {
    index: String(info.index),
    total: String(info.total),
    kept: info.kept != null ? String(info.kept) : "",
    name: info.name || "",
    path: info.path || "",
    url: info.remote || "",
    id: info.id || "",
    mime: info.mime || "",
    dims: info.dims || "",
    size: info.sizeText || "",
    identity: info.identity || "",
    hint: info.hint || "",
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}
