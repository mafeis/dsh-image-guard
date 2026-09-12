/**
 * dsh-image-guard 单元测试 —— 用假 fetch 真跑一遍守卫逻辑。
 * 用法: node tests/guard.test.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// 测试绝不能污染真实状态文件（否则会误判成"插件已被宿主加载"）
const TEST_STATUS = path.join(os.tmpdir(), "image-guard-test-status.json");
process.env.DSH_IMAGE_GUARD_STATUS = TEST_STATUS;
// 同理：也绝不能读到用户的真实配置——配置文件优先级高于本文件传入的 config，
// 一旦存在（如 ~/.dsh/image-guard.json 里 keepRecent=8），下面的断言就会被悄悄带偏。
process.env.DSH_IMAGE_GUARD_CONFIG = path.join(os.tmpdir(), "image-guard-test-config-absent.json");

const { apply } = await import("../lib/index.js");

const mk = (n, text = `msg-${n}`) => ({
  role: "user",
  content: [
    { type: "text", text },
    ...Array(n).fill(0).map((_, i) => ({ type: "image_url", image_url: { url: `data:image/png;base64,IMG${i}` } })),
  ],
});
const countImages = (body) =>
  (body.messages || []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0);
const countPlaceholders = (body) =>
  (body.messages || []).reduce(
    (a, m) =>
      a + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text" && typeof p.text === "string" && p.text.includes("已省略")).length : 0),
    0,
  );

let pass = 0;
let total = 0;
const t = async (name, fn) => {
  total++;
  const realFetch = globalThis.fetch;
  const calls = [];
  const serverLimit = fn.serverLimit ?? Infinity;
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(input), body });
    if (fn.otherError) {
      return new Response(JSON.stringify({ error: { message: "some other error" } }), { status: 400 });
    }
    const n = body ? countImages(body) : 0;
    if (n > serverLimit) {
      return new Response(JSON.stringify({ error: { message: `At most ${serverLimit} image(s) may be provided in one prompt.` } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, n }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const savedFetch = globalThis.fetch;
  const dispose = apply({ inject: () => {} }, { enabled: true, keepRecent: 12, learnLimit: true, maxRetries: 3, verbose: false });
  try {
    await fn.run(calls, savedFetch);
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  } finally {
    dispose?.();
    globalThis.fetch = realFetch;
  }
};

console.log("dsh-image-guard 单测");

await t("20 张图 → 只发最近 12 张，其余换占位", {
  serverLimit: Infinity,
  run: async (calls) => {
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [mk(20)] }) });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, "应只发一次");
    assert.equal(countImages(calls[0].body), 12);
    assert.equal(countPlaceholders(calls[0].body), 8);
  },
});

await t("服务端上限 8：先 400，学到上限后降级重试成功", {
  serverLimit: 8,
  run: async (calls) => {
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [mk(20)] }) });
    assert.equal(res.status, 200, "应通过重试成功");
    assert.equal(calls.length, 2, "应重试一次");
    assert.equal(countImages(calls[0].body), 12);
    assert.equal(countImages(calls[1].body), 7, "第二次应降到 7 张");
    assert.equal(JSON.parse(await res.text()).n, 7);
  },
});

await t("学到上限后，后续请求直接按 7 张发（不再吃 400）", {
  serverLimit: 8,
  run: async (calls) => {
    await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [mk(20)] }) }); // 学
    const before = calls.length;
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [mk(20)] }) });
    assert.equal(res.status, 200);
    assert.equal(calls.length - before, 1, "第二次请求应一次成功");
    assert.equal(countImages(calls[calls.length - 1].body), 7);
  },
});

await t("图片少于 keepRecent → 原样放行（不改 body）", {
  serverLimit: Infinity,
  run: async (calls) => {
    const raw = JSON.stringify({ messages: [mk(3)] });
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: raw });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body === null ? 0 : countImages(calls[0].body), 3);
    assert.equal(countPlaceholders(calls[0].body), 0);
  },
});

await t("纯文本请求 → 完全不干预", {
  serverLimit: Infinity,
  run: async (calls) => {
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  },
});

await t("非 chat 路径 → 不干预", {
  serverLimit: Infinity,
  run: async (calls) => {
    await fetch("https://gw/metrics");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, null);
  },
});

await t("400 但不是图片问题 → 原样返回，不重试", {
  serverLimit: Infinity,
  otherError: true,
  run: async (calls) => {
    const res = await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [mk(20)] }) });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 1, "不应重试");
  },
});

console.log(`\n通过 ${pass}/${total}`);
