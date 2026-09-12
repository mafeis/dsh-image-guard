/**
 * 自检与自愈测试：插件的命门是「包装真的在 globalThis.fetch 链上」。
 * 实测现象：宿主某次启动后包装已安装（状态文件亦已写出），但 LLM 请求未经过它。
 * 本文件锁住四件事：① 探针能证明自己在链上；② 被别人顶掉能自动重新接管（且永不放弃）；
 * ③ 接管的包装仍然会裁剪（而不是只挂个壳）。
 * 用法: node tests/selfcheck.test.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const TEST_STATUS = path.join(os.tmpdir(), "image-guard-selfcheck-status.json");
process.env.DSH_IMAGE_GUARD_STATUS = TEST_STATUS;
process.env.DSH_IMAGE_GUARD_CONFIG = path.join(os.tmpdir(), "image-guard-selfcheck-config-absent.json");
process.env.DSH_SETTINGS = path.join(os.tmpdir(), "image-guard-selfcheck-settings-absent.yaml"); // 隔离宿主界面语言

const { apply } = await import("../lib/index.js");

let pass = 0;
let total = 0;
const t = async (name, fn) => {
  total++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
};

const handle = () => globalThis[Symbol.for("dsh-image-guard")];
/**
 * 真正把 fetch 属性整个替换掉 —— 等价于「有人绕开经纪人、直接改写描述符」。
 * 普通赋值 `globalThis.fetch = x` 会被守卫的经纪人拦下（新包装器被收作下层），
 * 那种情况另有用例覆盖。
 */
const hijack = (fn) => Object.defineProperty(globalThis, "fetch", { value: fn, writable: true, configurable: true });
const mkBody = (n) => ({
  messages: [{ role: "user", content: [...Array(n).fill(0).map((_, i) => ({ type: "image_url", image_url: { url: `data:image/png;base64,I${i}` } }))] }],
});
const countImg = (b) => (b.messages || []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0);

const realFetch = globalThis.fetch;
let sent = [];
const recording = async (input, init) => {
  sent.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};
globalThis.fetch = recording;

console.log("image-guard 自检/自愈");

const dispose = apply({ inject: () => {} }, { enabled: true, keepRecent: 4, learnLimit: true, verbose: false });

await t("安装后句柄可用，且 fetch 确实是我的", () => {
  const h = handle();
  assert.ok(h, "应暴露 Symbol.for('dsh-image-guard') 调试句柄");
  assert.equal(globalThis.fetch, h.guardedFetch, "globalThis.fetch 应指向守卫");
  assert.equal(h.status().fetchOwned, true);
});

await t("探针能穿过守卫（证明我在链上）", async () => {
  const h = handle();
  const before = h.status().probeSeen;
  h.selfProbe();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.status().probes, 1);
  assert.equal(h.status().probeSeen, before + 1, "探针必须从守卫里穿过；为 0 就说明我不在链上");
  assert.equal(sent.length, 0, "探针绝不能真的外发");
});

await t("被第三方顶掉 → rewrap 重新接管，且新链首仍能裁剪", async () => {
  const h = handle();
  // 模拟"不链式"的第三方包装：它自己转发到我们记录用的 fetch
  const foreign = async (input, init) => recording(input, init);
  hijack(foreign);
  assert.equal(globalThis.fetch, foreign, "属性被整个替换后才算被顶掉");
  const took = h.rewrap("test");
  assert.equal(took, true, "应重新接管");
  assert.equal(globalThis.fetch, h.guardedFetch);

  sent = [];
  await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify(mkBody(10)) });
  assert.equal(sent.length, 1, "接管后请求仍应转发一次（经第三方那一层）");
  assert.equal(countImg(sent[0].body), 4, "接管后仍要按 keepRecent=4 裁剪");
});

await t("被顶掉后探针也能识别出来（探针 ==0 即不在链上）", async () => {
  const h = handle();
  hijack(async () => new Response("{}", { status: 200 })); // 顶掉，且不自愈（模拟看门狗尚未跑）
  const before = h.status().probeSeen;
  h.selfProbe();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.status().probeSeen, before, "被顶掉时守卫不该看到探针");
  h.rewrap("restore");
  assert.equal(globalThis.fetch, h.guardedFetch);
});

await t("反复被抢永不放弃：抢 8 次全部接管（net-proxy 频繁翻转系统代理的场景）", () => {
  const h = handle();
  const start = h.status().rewraps;
  for (let i = 0; i < 8; i++) {
    const foreign = async (input, init) => recording(input, init);
    hijack(foreign);
    assert.equal(h.rewrap("loop"), true, `第 ${i + 1} 次被抢后应抢回链首`);
    assert.equal(globalThis.fetch, h.guardedFetch);
  }
  assert.equal(h.status().rewraps - start, 8, "被抢几次就接管几次，不再中途放弃");
  assert.equal(h.status().fetchStolen, undefined, "「放弃自愈」状态已彻底移除");
  assert.ok(h.status().stolenSeen >= 8, "应累计链首被占用的次数");
  assert.equal(h.status().fetchOwned, true);
});

await t("普通赋值会被经纪人拦下：新包装器收作下层，守卫仍在链首", async () => {
  const h = handle();
  const inner = h.guardedFetch;
  let called = 0;
  const foreign = async (input, init) => {
    called++;
    return recording(input, init);
  };
  globalThis.fetch = foreign; // 普通赋值：经纪人应拦下
  assert.equal(globalThis.fetch, inner, "赋值被拦下后链首仍是守卫");
  assert.notEqual(globalThis.fetch, foreign);
  sent = [];
  const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify(mkBody(10)) });
  assert.equal(res.status, 200);
  assert.ok(called > 0, "新来的包装器仍应被调用（收作下层，不绕开它）");
  assert.equal(countImg(sent[0].body), 4, "裁剪照旧");
  assert.equal(h.status().stolenSeen >= 1, true, "应记录链首被占用");
});

await t("裁剪会累计「节省的 token」估算（每张 tokensPerImage − 标记开销）", async () => {
  const h = handle();
  h.rewrap("restore"); // 守卫在链首时返回 false，属正常；这里只保证它在链首
  assert.equal(globalThis.fetch, h.guardedFetch);
  const before = h.status().tokensSaved || 0;
  const droppedBefore = h.status().imagesDropped || 0;
  sent = [];
  await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify(mkBody(10)) }); // keepRecent=4 → 丢 6 张
  const after = h.status();
  assert.equal(after.imagesDropped - droppedBefore, 6, "应丢 6 张");
  assert.equal(after.tokensSaved - before, 6 * (972 - 40), "省 token = 6 张 × (972 − 40 标记开销)");
});

await t("dispose 后守卫退出（精确还原成我之下那一层）且句柄移除", () => {
  const h = handle();
  const myGuard = h.guardedFetch;
  const ghost = async () => new Response("{}", { status: 200 });
  hijack(ghost); // 顶掉守卫
  assert.equal(h.rewrap("final"), true, "重置后应能重新接管");
  assert.equal(globalThis.fetch, myGuard, "此刻守卫应在链首");
  assert.equal(typeof ghost, "function");
  dispose();
  assert.notEqual(globalThis.fetch, myGuard, "守卫必须被摘掉");
  assert.equal(globalThis.fetch, ghost, "应精确还原成本次接管前的那一层");
  assert.equal(handle(), undefined, "句柄应被移除");
});

console.log(`\n通过 ${pass}/${total}`);
