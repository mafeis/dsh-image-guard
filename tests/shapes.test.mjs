/**
 * 形态用例：确认守卫能识别各种请求形态，并留下诊断记录。
 * 用法: node tests/shapes.test.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const STATUS = path.join(os.tmpdir(), "image-guard-shapes-status.json");
process.env.DSH_IMAGE_GUARD_STATUS = STATUS;
// 同理隔离配置：真实配置（若存在）优先于本文件传入的 config，会带偏断言
process.env.DSH_IMAGE_GUARD_CONFIG = path.join(os.tmpdir(), "image-guard-shapes-config-absent.json");
process.env.DSH_SETTINGS = path.join(os.tmpdir(), "image-guard-shapes-settings-absent.yaml"); // 隔离宿主界面语言
const { apply } = await import("../lib/index.js");

const mkBody = (n) => ({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        ...Array(n).fill(0).map((_, i) => ({ type: "image_url", image_url: { url: `data:image/png;base64,I${i}` } })),
      ],
    },
  ],
});
const countImg = (b) => (!b ? -1 : (b.messages || []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0));

const real = globalThis.fetch;
let calls = [];
globalThis.fetch = async (input, init) => {
  const raw =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body).toString("utf8")
        : input instanceof Request
          ? await input.clone().text()
          : null;
  calls.push(raw ? JSON.parse(raw) : null);
  return new Response(JSON.stringify({ ok: true, n: raw ? countImg(JSON.parse(raw)) : -1 }), { status: 200 });
};
const dispose = apply({}, { keepRecent: 12, verbose: false });

let pass = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (cond) pass++;
  else process.exitCode = 1;
};

// ① (url, {body: string})
calls = [];
await fetch("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify(mkBody(20)) });
check("(url, {body: string}) 被拦截并裁到 12", countImg(calls[0]) === 12, `实发 ${countImg(calls[0])} 张`);

// ② (Request, undefined) —— 标准 fetch 下 init.body 覆写 Request.body 是否有效
calls = [];
const req = new Request("https://gw/v1/chat/completions", { method: "POST", body: JSON.stringify(mkBody(20)) });
await fetch(req);
check("(Request, undefined) 被拦截并裁到 12", countImg(calls[0]) === 12, `实发 ${countImg(calls[0])} 张`);

// ③ 跨 realm 的 Request 鸭子对象（instanceof 会失败）
calls = [];
const fakeCtor = class FakeRequest {};
const foreignReq = new fakeCtor();
foreignReq.url = "https://gw/v1/chat/completions";
foreignReq.method = "POST";
foreignReq._body = JSON.stringify(mkBody(20));
foreignReq.clone = () => ({ text: async () => foreignReq._body });
foreignReq.text = async () => foreignReq._body;
await fetch(foreignReq, {});
check("foreign-Request 可被识别（不会被跳过）", countImg(calls[0]) === 12, `实发 ${countImg(calls[0])} 张`);

// ④ body 为流：无法解析 → 原样放行，但诊断里必须留下 read:false
calls = [];
const stream = new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode(JSON.stringify(mkBody(20))));
    c.close();
  },
});
await fetch("https://gw/v1/chat/completions", { method: "POST", body: stream, duplex: "half" });
check("流式 body 原样放行（未改内容）", calls[0] === null || countImg(calls[0]) === 20, `fake 读到 ${countImg(calls[0])}`);

// 诊断记录（状态文件节流写盘，等一次刷新）
await new Promise((r) => setTimeout(r, 1100));
const j = JSON.parse(fs.readFileSync(STATUS, "utf8"));
const diag = j.diag ?? [];
check(`诊断有记录（${diag.length} 条）`, diag.length >= 4);
for (const d of diag) console.log(`        ${JSON.stringify(d)}`);
check("诊断里出现了 foreign-Request", diag.some((d) => String(d.input).startsWith("foreign-Request")));
check("诊断里记录了流式体", diag.some((d) => d.read === false));

console.log(`\n通过 ${pass}/7`);
dispose();
globalThis.fetch = real;
