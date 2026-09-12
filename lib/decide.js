// lib/decide.js — 纯决策逻辑：什么时候裁、裁到几张、400 之后怎么降级
//
// 不碰网络、不碰文件，全部可单测。

/**
 * 从上游 400 的报文里解析出「一次最多几张图」。
 * 目前覆盖 vLLM / OpenAI 兼容网关的英文措辞与中文措辞。
 * @returns {number|null} 解析不到返回 null（调用方应原样返回响应，不要乱重试）
 */
export function parseImageLimit(text) {
  if (typeof text !== "string" || !text) return null;
  const m = /At most\s+(\d+)\s+image/i.exec(text) || /最多\s*(\d+)\s*张图/.exec(text) || /images?[^0-9]{0,20}(\d+)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 已经学到上限后又吃了一次 400 时，下一轮把 keep 降到多少。
 * 取「服务端上限 - 1」与「当前 keep - 1」的较小者，保证一定比上一轮更小（避免原地打转）。
 */
export function nextKeep(limit, keep) {
  return Math.max(0, Math.min(limit - 1, keep > 0 ? keep - 1 : 0));
}

/** 本进程实际生效的保留张数：配置的 keepRecent 与「学到的上限 - 1」取小。 */
export function effectiveKeep(keepRecent, learnedLimit) {
  if (learnedLimit == null) return keepRecent;
  return Math.min(keepRecent, Math.max(0, learnedLimit - 1));
}

/** 是否需要裁剪。 */
export function shouldTrim(imageCount, keep) {
  return imageCount > Math.max(0, keep);
}

/**
 * 是否该把这轮响应交回调用方（而不是继续重试）。
 * @param {number} status 响应码
 * @param {number} attempt 已重试次数
 * @param {number} maxRetries 允许的重试上限
 */
export function shouldGiveUp(status, attempt, maxRetries) {
  return status !== 400 || attempt >= maxRetries;
}

/**
 * 默认的「省略标记」模板。
 *
 * 设计要点：
 *  1. 必须携带身份（文件名/路径/指纹）——光说"图片已省略"等于把信息抹掉，
 *     模型既不知道少了哪张、也无法按需取回。
 *  2. 默认**不含** {total} / {kept} 这类会随会话增长的字段：被省略的图在上下文里位置靠前，
 *     标记一变，服务端前缀缓存从这里往后全部失效。要用可以，但要知道代价。
 *
 * 可用占位符：{index} {total} {kept} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}
 */
export const DEFAULT_MARKER = "[图片已省略 #{index}{identity}{hint}]";

/** @deprecated 旧名，等价于 DEFAULT_MARKER（配置字段名仍叫 placeholder）。 */
export const DEFAULT_PLACEHOLDER = DEFAULT_MARKER;
