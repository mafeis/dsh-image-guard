/**
 * 单元测试：decide（纯决策）/ config（校验与读写）/ routes（状态与配置路由）
 * 用法: node tests/units.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

process.env.DSH_IMAGE_GUARD_STATUS = path.join(os.tmpdir(), "image-guard-units-status.json");
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ig-home-"));

const { parseImageLimit, nextKeep, effectiveKeep, shouldTrim, shouldGiveUp, DEFAULT_MARKER, DEFAULT_MARKER_EN } = await import("../lib/decide.js");
const { normalize, loadConfig, writeConfig, configPath, defaults, hostLocale, effectiveMarkerLang, viewConfig, isDefaultMarker } = await import("../lib/config.js");
const { makeHandler } = await import("../lib/routes.js");

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
const ta = async (name, fn) => {
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

console.log("decide.js");

t("parseImageLimit 解析 vLLM 英文措辞", () => {
  assert.equal(parseImageLimit('{"message":"At most 8 image(s) may be provided in one prompt. (parameter=image)"}'), 8);
  assert.equal(parseImageLimit("At most 16 images may be provided"), 16);
});
t("parseImageLimit 解析中文措辞", () => assert.equal(parseImageLimit("最多 4 张图片"), 4));
t("parseImageLimit 对无关报文返回 null（不能乱重试）", () => {
  assert.equal(parseImageLimit("maximum context length is 8192 tokens"), null);
  assert.equal(parseImageLimit(""), null);
  assert.equal(parseImageLimit(undefined), null);
});
t("nextKeep 一定比上一轮更小（不会原地打转）", () => {
  assert.equal(nextKeep(8, 12), 7);
  assert.equal(nextKeep(8, 7), 6);
  assert.equal(nextKeep(0, 3), 0);
  assert.equal(nextKeep(1, 0), 0);
});
t("effectiveKeep 取配置与「学到的上限-1」的较小者", () => {
  assert.equal(effectiveKeep(12, null), 12);
  assert.equal(effectiveKeep(12, 8), 7);
  assert.equal(effectiveKeep(5, 8), 5);
});
t("shouldTrim / shouldGiveUp", () => {
  assert.equal(shouldTrim(14, 12), true);
  assert.equal(shouldTrim(12, 12), false);
  assert.equal(shouldGiveUp(400, 0, 3), false);
  assert.equal(shouldGiveUp(400, 3, 3), true);
  assert.equal(shouldGiveUp(200, 1, 3), true);
});

console.log("config.js");

t("normalize 夹取非法数值而不是原样落盘", () => {
  assert.equal(normalize({ keepRecent: -5 }).keepRecent, 0);
  assert.equal(normalize({ keepRecent: 99999 }).keepRecent, 999);
  assert.equal(normalize({ keepRecent: "abc" }).keepRecent, defaults().keepRecent);
  assert.equal(normalize({ maxRetries: 99 }).maxRetries, 10);
});
t("normalize 拒绝非法正则", () => assert.throws(() => normalize({ matchPath: "([unclosed" }), /matchPath/));
t("normalize 布尔宽松归一化（0/'no' 不再是 true）", () => {
  const n = normalize({ enabled: 0, learnLimit: "no", dryRun: 1, verbose: "off" });
  assert.equal(n.enabled, false);
  assert.equal(n.learnLimit, false);
  assert.equal(n.dryRun, true);
  assert.equal(n.verbose, false);
  assert.equal(normalize({ enabled: "yes" }).enabled, true);
  assert.equal(normalize({ enabled: "随便" }).enabled, defaults().enabled); // 无法识别 → 默认值
});
t("写-读往返一致（原子落盘）", () => {
  const f = path.join(process.env.DSH_HOME, "round.json");
  const saved = writeConfig({ keepRecent: 7, dryRun: true }, f);
  assert.deepEqual(loadConfig(f), saved);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).keepRecent, 7);
});
t("configPath 跟 DSH_HOME 走", () => assert.equal(configPath(), path.join(process.env.DSH_HOME, "image-guard.json")));

console.log("routes.js");

const mkReq = (method, url, body) => {
  const r = new PassThrough();
  r.method = method;
  r.url = url;
  if (body !== undefined) r.end(body);
  else r.end();
  return r;
};
const mkRes = () => {
  const out = { code: 0, headers: null, body: "" };
  return {
    out,
    writeHead(code, headers) {
      out.code = code;
      out.headers = headers;
    },
    end(s) {
      out.body = s || "";
    },
  };
};

const file = path.join(process.env.DSH_HOME, "route.json");
fs.writeFileSync(file, JSON.stringify({ keepRecent: 9 }), "utf8");
let changed = null;
const handler = makeHandler({
  file,
  getStatus: () => ({ bundled: 3, trimmed: 1 }),
  onChanged: (c) => {
    changed = c;
  },
});

await ta("GET 返回配置 + 状态", async () => {
  const res = mkRes();
  await handler(mkReq("GET", "/_dsh/image-guard"), res);
  assert.equal(res.out.code, 200);
  const j = JSON.parse(res.out.body);
  assert.equal(j.config.keepRecent, 9);
  assert.equal(j.status.bundled, 3);
  assert.equal(j.meta.name, "dsh-image-guard");
});
await ta("PUT 合并并持久化 + 触发 onChanged", async () => {
  const res = mkRes();
  await handler(mkReq("PUT", "/_dsh/image-guard", JSON.stringify({ keepRecent: 4, dryRun: true })), res);
  assert.equal(res.out.code, 200);
  const j = JSON.parse(res.out.body);
  assert.equal(j.config.keepRecent, 4);
  assert.equal(j.config.dryRun, true);
  assert.equal(loadConfig(file).keepRecent, 4);
  assert.equal(changed.keepRecent, 4);
});
await ta("PUT 非法 JSON → 400 且不落盘", async () => {
  const before = loadConfig(file).keepRecent;
  const res = mkRes();
  await handler(mkReq("PUT", "/_dsh/image-guard", "{oops"), res);
  assert.equal(res.out.code, 400);
  assert.equal(loadConfig(file).keepRecent, before);
});
await ta("POST ?reset=1 回到默认值", async () => {
  const res = mkRes();
  await handler(mkReq("POST", "/_dsh/image-guard?reset=1"), res);
  assert.equal(JSON.parse(res.out.body).config.keepRecent, defaults().keepRecent);
});
await ta("DELETE → 405", async () => {
  const res = mkRes();
  await handler(mkReq("DELETE", "/_dsh/image-guard"), res);
  assert.equal(res.out.code, 405);
});

/* ---------------- 标记语言：未配置时跟随宿主界面语言 ---------------- */

const settingsFile = path.join(process.env.DSH_HOME, "settings.yaml");
// 每个用例写成不同长度，避免 mtime+size 缓存键在同毫秒内撞车
let localeStamp = 0;
const withLocale = (text) => {
  // 尺寸按 8 字节递增：mtime+size 缓存键不会因为「内容长度互相抵消」而撞车
  fs.writeFileSync(settingsFile, text + "#" + "x".repeat(++localeStamp * 8) + "\n", "utf8");
  process.env.DSH_SETTINGS = settingsFile;
};

t("hostLocale 只认顶层 locale 段的 preference（读不到按中文兜底）", () => {
  withLocale("locale:\n  preference: en\nui-theme:\n  preference: system\n");
  assert.equal(hostLocale(), "en");
  withLocale("locale:\n  preference: zh-CN\n");
  assert.equal(hostLocale(), "zh", "zh-CN 归到中文");
  withLocale("locale:\n  preference: en-US\n");
  assert.equal(hostLocale(), "en", "en-US 归到英文");
  withLocale("ui-theme:\n  preference: en\n");
  assert.equal(hostLocale(), "zh", "别的段里的 preference 不算数");
  withLocale("locale:\n  other: 1\n");
  assert.equal(hostLocale(), "zh", "locale 段里没有 preference 也无所谓");
  process.env.DSH_SETTINGS = path.join(process.env.DSH_HOME, "no-such-settings.yaml");
  assert.equal(hostLocale(), "zh", "文件缺失必须兜底，不能抛错");
});

t("effectiveMarkerLang：显式配置优先，未配置时跟随界面语言", () => {
  withLocale("locale:\n  preference: en\n");
  assert.equal(effectiveMarkerLang({ markerLang: "zh" }), "zh", "显式 zh 不被界面语言覆盖");
  assert.equal(effectiveMarkerLang({ markerLang: "" }), "en", "空 = 跟随界面");
  assert.equal(effectiveMarkerLang(null), "en");
  withLocale("locale:\n  preference: zh\n");
  assert.equal(effectiveMarkerLang({ markerLang: "en" }), "en");
  assert.equal(effectiveMarkerLang({}), "zh");
});

t("viewConfig 把跟随态解析出来并标明 markerLangAuto", () => {
  withLocale("locale:\n  preference: en\n");
  assert.equal(viewConfig(null).markerLang, "en");
  assert.equal(viewConfig(null).markerLangAuto, true);
  assert.equal(viewConfig({ markerLang: "zh" }).markerLang, "zh");
  assert.equal(viewConfig({ markerLang: "zh" }).markerLangAuto, false);
});

t("normalize：markerLang 只认 zh/en，其余当跟随；placeholder 默认空", () => {
  assert.equal(normalize({ markerLang: "zz" }).markerLang, "");
  assert.equal(normalize({ markerLang: "EN" }).markerLang, "", "大小写不宽容，脏值一律跟随");
  assert.equal(normalize({ markerLang: "en" }).markerLang, "en");
  assert.equal(defaults().markerLang, "");
  assert.equal(defaults().placeholder, "");
});

t("placeholder 等于某语言默认模板时视为未自定义（0.8.11 会把默认值存进配置）", () => {
  assert.equal(normalize({ placeholder: DEFAULT_MARKER }).placeholder, "", "中文默认模板 → 折叠为空");
  assert.equal(normalize({ placeholder: DEFAULT_MARKER_EN }).placeholder, "", "英文默认模板 → 折叠为空");
  assert.equal(normalize({ placeholder: "[[{index}]]" }).placeholder, "[[{index}]]", "真正的自定义要原样保留");
  assert.equal(isDefaultMarker(DEFAULT_MARKER), true);
  assert.equal(isDefaultMarker("[x]"), false);
});

t("英文界面 + 存着中文默认模板 → 生效模板取英文（不再留中文）", () => {
  withLocale("locale:\n  preference: en\n");
  const v = viewConfig({ placeholder: DEFAULT_MARKER, pathMode: "basename" });
  assert.equal(v.placeholder, "", "默认模板被折叠，交给语言决定");
  assert.equal(v.markerLang, "en");
  assert.equal(v.markerLangAuto, true);
});

console.log(`\n通过 ${pass}/${total}`);