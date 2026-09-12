/**
 * 边界用例：请求发出后上游报错/被中断，守卫**不得重发**。
 * 用法: node tests/abort.test.mjs
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DSH_IMAGE_GUARD_STATUS = path.join(os.tmpdir(), "image-guard-abort-status.json");
process.env.DSH_SETTINGS = path.join(os.tmpdir(), "image-guard-abort-settings-absent.yaml"); // 隔离宿主界面语言
const { apply } = await import("../lib/index.js");

const real = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  throw new Error("ECONNRESET");
};
const dispose = apply({}, { keepRecent: 12, verbose: false });
const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });
try {
  await fetch("https://gw/v1/chat/completions", { method: "POST", body });
  console.log("  ❌ 应当抛错但没有");
  process.exitCode = 1;
} catch (e) {
  console.log(`  ✅ 调用方收到原始错误: ${e.message}`);
}
console.log(`  实际发出请求次数: ${calls} ${calls === 1 ? "✅ 只发一次（不重发）" : "❌ 重发了 " + calls + " 次"}`);
if (calls !== 1) process.exitCode = 1;
dispose();
globalThis.fetch = real;
