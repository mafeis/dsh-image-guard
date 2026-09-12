/**
 * 省略标记测试：标记必须说清「少了哪张图、去哪找」，
 * 同时**默认不得把本机目录结构发出去**（标记最终会进请求体，发给服务端）。
 * 用的是 DSH 消息的**真实形态**（<path> 文本片段 + image_url data URL / attachment）。
 * 用法: node tests/marker.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { stripImages, extractImageInfo, renderMarker } from "../lib/shapes.js";
import { DEFAULT_MARKER } from "../lib/decide.js";

let pass = 0;
let total = 0;
const t = (name, fn) => {
  total++;
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
};

// DSH 真实形态：图片前一个 text 片段带 <path> 与尺寸；图片本体是 image_url data URL
const dshMsg = (file, dir, b64, w = 1280, h = 720, bytes = 633106) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<path>${dir}\\${file}</path>\n<type>image</type>\n<content>\nimage/png image, ${w}x${h} px, ${bytes} bytes\n</content>`,
    },
    { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
  ],
});
const body = (...msgs) => ({ model: "x", messages: msgs });
const textsOf = (payload) => payload.messages.flatMap((m) => m.content.filter((p) => p.type === "text").map((p) => p.text));

const DIR = "C:\\projects\\demo\\shots";
const B1 = "A".repeat(2000);
const B2 = "B".repeat(2400);
const B3 = "C".repeat(2800);

console.log("真实形态（DSH：<path> + data URL）");

t("默认（basename）只给文件名，不给目录——标记要发给服务端", () => {
  const { payload, dropped } = stripImages(body(dshMsg("01-race-start.png", DIR, B1), dshMsg("07-track0.png", DIR, B2), dshMsg("09-hud.png", DIR, B3)), 1, DEFAULT_MARKER);
  assert.equal(dropped, 2);
  const marks = textsOf(payload).filter((s) => s.startsWith("[图片已省略"));
  assert.equal(marks.length, 2);
  assert.ok(marks[0].includes("01-race-start.png"), "应含文件名: " + marks[0]);
  assert.ok(marks[0].includes("read_image") || marks[0].includes("搜索"), "应告诉 agent 怎么取回: " + marks[0]);
  assert.ok(marks[1].includes("07-track0.png"), "第二张也要有名字: " + marks[1]);
  for (const m of marks) {
    assert.ok(!m.includes("projects"), "默认不得泄露目录: " + m);
    assert.ok(!/[A-Za-z]:\\/.test(m), "默认不得泄露盘符/绝对路径: " + m);
  }
  console.log(`        ${marks[0]}`);
  console.log(`        ${marks[1]}`);
});

t("pathMode=full 才给完整路径（显式选择）", () => {
  const { payload } = stripImages(body(dshMsg("07-track0.png", DIR, B2)), 0, DEFAULT_MARKER, { pathMode: "full" });
  const mark = textsOf(payload).find((s) => s.startsWith("[图片已省略"));
  assert.ok(mark.includes(DIR + "\\07-track0.png"), mark);
  assert.ok(mark.includes("read_image"), mark);
});

t("pathMode=relative 相对工作区；工作区外的路径退化成文件名", () => {
  const inside = path.join(process.cwd(), "shots", "inside.png");
  const a = textsOf(stripImages(body(dshMsg("inside.png", path.dirname(inside), B1)), 0, DEFAULT_MARKER, { pathMode: "relative" }).payload).find((s) => s.includes("图片已省略"));
  assert.ok(a.includes("shots/inside.png") || a.includes("shots\\inside.png"), "应相对化: " + a);
  assert.ok(!a.includes(process.cwd()), "不应出现工作区绝对路径: " + a);
  const outside = textsOf(stripImages(body(dshMsg("x.png", DIR, B1)), 0, DEFAULT_MARKER, { pathMode: "relative" }).payload).find((s) => s.includes("图片已省略"));
  assert.ok(!outside.includes("projects"), "工作区/家目录之外只留文件名: " + outside);
});

t("pathMode=none 完全不显示路径，并说明原因", () => {
  const mark = textsOf(stripImages(body(dshMsg("07-track0.png", DIR, B2)), 0, DEFAULT_MARKER, { pathMode: "none" }).payload).find((s) => s.includes("图片已省略"));
  assert.ok(!mark.includes("07-track0.png"), "连文件名也不给: " + mark);
  assert.ok(mark.includes("隐去"), "要说明这张图的路径被隐去: " + mark);
});

t("裁剪的是最早的，最近的 keep 张仍为图片", () => {
  const { payload } = stripImages(body(dshMsg("a.png", DIR, B1), dshMsg("b.png", DIR, B2), dshMsg("c.png", DIR, B3)), 2, DEFAULT_MARKER);
  const kinds = payload.messages.map((m) => m.content.map((p) => p.type).join("+"));
  assert.equal(kinds[0], "text+text", "最早一张被替换为文本");
  assert.equal(kinds[1], "text+image_url");
  assert.equal(kinds[2], "text+image_url");
});

t("index 是全局序号且稳定（前缀缓存友好：默认模板不含 total/kept）", () => {
  const a = stripImages(body(dshMsg("a.png", DIR, B1), dshMsg("b.png", DIR, B2)), 1, DEFAULT_MARKER).payload;
  const b = stripImages(body(dshMsg("a.png", DIR, B1), dshMsg("b.png", DIR, B2), dshMsg("c.png", DIR, B3)), 1, DEFAULT_MARKER).payload;
  const ma = textsOf(a).find((s) => s.startsWith("[图片已省略"));
  const mb = textsOf(b).find((s) => s.startsWith("[图片已省略"));
  assert.equal(ma, mb, "同一张图在 total 变化后标记必须一模一样，否则前缀缓存被冲掉");
  assert.ok(ma.includes("#1"), "序号从 1 开始: " + ma);
});

t("含 {total} 的模板会随会话增长而变（已知代价，需用户明确选择）", () => {
  const tpl = "[图片已省略 #{index}/{total}]";
  const a = textsOf(stripImages(body(dshMsg("a.png", DIR, B1), dshMsg("b.png", DIR, B2)), 1, tpl).payload).find((s) => s.includes("图片已省略"));
  const b = textsOf(stripImages(body(dshMsg("a.png", DIR, B1), dshMsg("b.png", DIR, B2), dshMsg("c.png", DIR, B3)), 1, tpl).payload).find((s) => s.includes("图片已省略"));
  assert.equal(a, "[图片已省略 #1/2]");
  assert.equal(b, "[图片已省略 #1/3]");
});

console.log("其它形态");

t("DSH attachment 形态（消息里保留 attachment 元数据）", () => {
  const msg = {
    role: "user",
    content: [
      { type: "text", text: "<type>image</type>" },
      { type: "image", attachment: { attachmentId: "sha256:bf23bcd3", mediaType: "image/png", bytes: 633106, width: 1280, height: 720, name: "01-race-start.png" } },
    ],
  };
  const { payload } = stripImages(body(msg), 0, DEFAULT_MARKER);
  const mark = textsOf(payload).find((s) => s.startsWith("[图片已省略"));
  assert.ok(mark.includes("01-race-start.png"), "文件名必须在: " + mark);
  assert.ok(mark.includes("sha256:bf23bcd3"), "应带指纹: " + mark);
  assert.ok(mark.includes("1280x720"), "应带尺寸: " + mark);
  assert.ok(mark.includes("618 KiB"), "应带大小: " + mark);
  console.log(`        ${mark}`);
});

t("远端 URL：给出地址与重新访问提示", () => {
  const msg = { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/shots/race.png?x=1" } }] };
  const { payload } = stripImages(body(msg), 0, DEFAULT_MARKER);
  const mark = textsOf(payload).find((s) => s.startsWith("[图片已省略"));
  assert.ok(mark.includes("https://example.com/shots/race.png?x=1"), mark);
  assert.ok(mark.includes("重新访问"), mark);
  console.log(`        ${mark}`);
});

t("毫无线索的内联图：给出指纹/类型/尺寸，并明说取不回", () => {
  const msg = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + B1 } }] };
  const { payload } = stripImages(body(msg), 0, DEFAULT_MARKER);
  const mark = textsOf(payload).find((s) => s.startsWith("[图片已省略"));
  assert.ok(/sha1:[0-9a-f]{8}/.test(mark), "应有指纹: " + mark);
  assert.ok(mark.includes("image/png"), mark);
  assert.ok(mark.includes("1.5 KiB"), "2000 字符 base64 ≈ 1500B: " + mark);
  assert.ok(mark.includes("无法取回"), "必须诚实说明取不回: " + mark);
  console.log(`        ${mark}`);
});

t("指纹稳定：同一张图两次得到同一个 id", () => {
  const one = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + B1 } }] };
  const i1 = extractImageInfo(one.content[0], one.content, 0, { index: 1, total: 1 });
  const i2 = extractImageInfo(one.content[0], one.content, 0, { index: 5, total: 9 });
  assert.equal(i1.id, i2.id);
  assert.ok(i1.id.startsWith("sha1:"));
});

console.log("保留策略：留最新、丢最早（按文件名逐张断言）");

t("9 张图 keep=3 → 保留的正好是最后 3 张（最新），丢的是最早 6 张", () => {
  const msgs = [];
  for (let i = 1; i <= 9; i++) msgs.push(dshMsg(`im0${i}.png`, DIR, "X".repeat(400 + i)));
  const { payload, dropped } = stripImages(body(...msgs), 3, DEFAULT_MARKER);
  assert.equal(dropped, 6);
  const kinds = payload.messages.map((m) => m.content[1].type);
  assert.deepEqual(kinds, ["text", "text", "text", "text", "text", "text", "image_url", "image_url", "image_url"], "前 6 条被替换为文本、后 3 条仍为图片");
  const marks = textsOf(payload).filter((s) => s.startsWith("[图片已省略"));
  ["im01", "im02", "im03", "im04", "im05", "im06"].forEach((n, i) => assert.ok(marks[i].includes(n + ".png"), `第 ${i + 1} 个标记应指向 ${n}（最早一张）：${marks[i]}`));
  for (const n of ["im07", "im08", "im09"]) {
    assert.ok(!marks.some((s) => s.includes(n + ".png")), `${n} 属于最新 N 张，不应被替换为标记`);
  }
  assert.ok(payload.messages[8].content[1].image_url.url.startsWith("data:image/png;base64,"), "第 9 张必须原样保留");
  console.log(`        丢掉首张 → ${marks[0]}`);
});

t("嵌套形态（tool-result 里再套 content）也要能数到、能裁掉", () => {
  const nested = (file, b64) => ({
    role: "user",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        content: [
          { type: "text", text: `<path>${DIR}\\${file}</path>\n<content>\nimage/png image, 640x480 px, 9000 bytes\n</content>` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  });
  const flat = dshMsg("tail.png", DIR, "T".repeat(500));
  const { payload, dropped } = stripImages(body(nested("old-a.png", "A".repeat(500)), nested("old-b.png", "B".repeat(500)), flat), 1, DEFAULT_MARKER);
  assert.equal(dropped, 2, "嵌套的两张也要被数到");
  const inner = payload.messages[0].content[0].content;
  assert.equal(inner[1].type, "text", "嵌套中的图片应被替换为标记");
  assert.ok(inner[1].text.includes("old-a.png"), "标记应取用嵌套里相邻的 <path>：" + inner[1].text);
  assert.equal(payload.messages[2].content[1].type, "image_url", "最新的那张保留");
  console.log(`        嵌套标记 → ${inner[1].text}`);
});

console.log("模板");

t("自定义模板各占位符都生效", () => {
  const msg = dshMsg("07-track0.png", DIR, B2);
  const info = extractImageInfo(msg.content[1], msg.content, 1, { index: 3, total: 7, kept: 4 });
  // 大小取自**实际发出的 base64 载荷**（2400 字符 ≈ 1800B），而不是旁边文本里写的数字
  assert.equal(renderMarker(info, "#{index}/{total} kept={kept} {name} {dims} {size}"), "#3/7 kept=4 07-track0.png 1280x720 1.8 KiB");
  assert.ok(renderMarker(info, "{path}").endsWith("07-track0.png"));
  assert.ok(renderMarker(info, "{id}").startsWith("sha1:"));
});

t("不含占位符的老配置原样输出（向后兼容）", () => {
  const msg = dshMsg("a.png", DIR, B1);
  const info = extractImageInfo(msg.content[1], msg.content, 1, { index: 1, total: 1 });
  assert.equal(renderMarker(info, "[图片已省略]"), "[图片已省略]");
});

t("空模板回落到默认模板", () => {
  const msg = dshMsg("a.png", DIR, B1);
  const info = extractImageInfo(msg.content[1], msg.content, 1, { index: 1, total: 1 });
  assert.ok(renderMarker(info, "").includes("a.png"));
  assert.ok(renderMarker(info, null).includes("a.png"));
});

console.log(`\n通过 ${pass}/${total}`);
