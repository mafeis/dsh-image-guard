/**
 * 客户端半边测试：用桩 React / jsx-runtime / primitives / document 真跑一遍
 *  ① __ModuleLoader__ 工厂能否加载
 *  ② apply(ctx) 是否注册了 settings.section 插槽、注入了样式
 *  ③ 组件挂载后能否读到配置与统计并渲染出正确文案（不依赖浏览器）
 * 用法: node tests/client.test.mjs
 */
import assert from "node:assert/strict";

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

/* ---------- 桩：极小 React（支持 useState/useEffect/useRef + 重渲染） ---------- */

function createMiniReact() {
  let hooks = [];
  let cursor = 0;
  let pendingEffects = [];
  let rerender = null;

  const api = {
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      return [
        hooks[i],
        (v) => {
          hooks[i] = typeof v === "function" ? v(hooks[i]) : v;
          if (rerender) rerender();
        },
      ];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = hooks[i];
      const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
      if (changed) {
        hooks[i] = { deps: deps || null };
        pendingEffects.push(fn);
      }
    },
    useRef(v) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: v };
      return hooks[i];
    },
    _begin() {
      cursor = 0;
      pendingEffects = [];
    },
    _effects() {
      const e = pendingEffects;
      pendingEffects = [];
      return e;
    },
    _setRerender(fn) {
      rerender = fn;
    },
    _reset() {
      hooks = [];
      cursor = 0;
      pendingEffects = [];
    },
  };
  return api;
}

/** 挂载一个函数组件：跑 effect、允许 setState 触发重渲染，返回当前树。 */
function mount(component, props, mini) {
  mini._reset(); // 每次挂载都是新实例，hook 槽位必须重来（真 React 也如此）
  let tree = null;
  const render = () => {
    mini._begin();
    tree = component(props);
    for (const fn of mini._effects()) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  };
  const cleanups = [];
  mini._setRerender(render);
  render();
  return {
    get tree() {
      return tree;
    },
    rerender: render,
    unmount() {
      for (const c of cleanups) c();
    },
  };
}

/** 把 React 元素树拍平成字符串，便于断言文案。 */
function textOf(node) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    if (node.type && typeof node.type === "function") return textOf(node.type(node.props || {}));
    return textOf(node.props ? node.props.children : "");
  }
  return "";
}
function findAll(node, pred, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, pred, out));
    return out;
  }
  if (node.type && typeof node.type === "function") {
    findAll(node.type(node.props || {}), pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  findAll(node.props ? node.props.children : null, pred, out);
  return out;
}

/* ---------- 桩：document / fetch / modules ---------- */

const injected = [];
globalThis.document = {
  getElementById: (id) => injected.find((s) => s.id === id) || null,
  createElement: () => ({ id: "", setAttribute(k, v) { this[k] = v; }, textContent: "" }),
  head: { appendChild: (el) => injected.push(el) },
  documentElement: { appendChild: (el) => injected.push(el) },
};

let fetchCalls = [];
const FAKE_STATUS = {
  pid: 12345,
  chatPosts: 9,
  bundled: 8,
  trimmed: 4,
  imagesDropped: 17,
  tokensSaved: 16388,
  retried: 1,
  learnedLimit: 8,
  maxSeen: 14,
  dryRunSkips: 0,
  fetchOwned: true,
  rewraps: 1,
  fetchStolen: false,
  probes: 3,
  probeSeen: 3,
  startedAt: new Date(Date.now() - 180000).toISOString(),
  diag: [{ at: "15:51:25", input: "url-string", body: "string", read: true, imgs: 14, msgs: 494, bytes: 9200000 }],
};
const FAKE_CONFIG = { enabled: true, keepRecent: 12, maxRetries: 3, learnLimit: true, dryRun: false, matchPath: "/chat/completions|/messages", placeholder: "", markerLang: "zh", pathMode: "basename", tokensPerImage: 972, verbose: true };
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: (init && init.method) || "GET", headers: (init && init.headers) || null, body: init && init.body });
  return {
    ok: true,
    json: async () => ({ ok: true, config: FAKE_CONFIG, status: FAKE_STATUS, meta: { name: "dsh-image-guard" } }),
  };
};

let loadedFactory = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { loadedFactory = def; } } };

const mini = createMiniReact();
const Prm = {
  Button: function Button(props) { return { type: "button", props }; },
  Input: function Input(props) { return { type: "input", props }; },
  // 原生原子：Pill / Switch 渲染成 button，Tag 渲染成 span
  Pill: function Pill(props) { return { type: "button", props }; },
  Switch: function Switch(props) { return { type: "button", props: { ...props, role: "switch", "aria-checked": props.checked, children: null } }; },
  Tag: function Tag(props) { return { type: "span", props: { ...props, "data-tone": props.tone } }; },
};
const requireStub = (name) => {
  if (name === "react") return { useState: mini.useState, useEffect: mini.useEffect, useRef: mini.useRef, createElement: () => ({}) };
  if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props: props || {}, key }), jsxs: (type, props, key) => ({ type, props: props || {}, key }) };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return Prm;
  throw new Error("unknown module: " + name);
};

await import("../lib/client.js");

console.log("client.js");

await t("__ModuleLoader__.load 被调用，id 正确", () => {
  assert.ok(loadedFactory, "没有调用 load");
  assert.equal(loadedFactory.id, "dsh-image-guard");
});

const mod = loadedFactory.factory(requireStub);

await t("工厂导出 apply / inject", () => {
  assert.equal(typeof mod.apply, "function");
  assert.deepEqual(mod.inject, ["slots", "locale"]);
});

/* ---------------- 注册：只能有一个一级菜单 ---------------- */

await t("apply(ctx) 只注册**一个**一级菜单 image-guard（order 41），并注入样式与中英词典", () => {
  const registered = [];
  const locales = [];
  const ctx = {
    locale: { bind: (ns) => (k) => `${ns}:${k}`, register: (ns, dict) => { locales.push({ ns, dict }); return () => {}; } },
    effect: (fn) => fn(),
    slots: {
      inject: (name, cb) => { assert.equal(name, "settings.section"); cb(); },
      register: (meta, comp) => { registered.push({ meta, comp }); return () => {}; },
    },
  };
  mod.apply(ctx);
  assert.equal(registered.length, 1, "一级菜单只能有一个：图片守卫");
  assert.equal(registered[0].meta.id, "image-guard");
  assert.equal(registered[0].meta.order, 41);
  assert.equal(typeof registered[0].meta.label(), "string");
  assert.equal(typeof registered[0].comp, "function");
  assert.equal(locales.length, 1);
  for (const k of ["nav", "tabOverview", "tabParams", "tabDiag", "what", "how", "effect"]) {
    assert.ok(locales[0].dict.zh[k] && locales[0].dict.en[k], "中英词条都要有: " + k);
  }
  assert.equal(injected.length, 1);
  assert.equal(injected[0]["data-plugin-css"], "");
  assert.ok(injected[0].textContent.includes(".ig-tabs"), "样式内容要注入");
});

await t("apply 抛异常时不影响宿主（不向外冒泡）", () => {
  mod.apply({ locale: { bind: () => () => "" }, effect: () => {}, slots: { inject: () => { throw new Error("boom"); }, register: () => {} } });
});

/* ---------------- 结构：一级菜单 + 页内二级 tab ---------------- */

await t("一级菜单里是**页内二级 tab**：三个原生 Pill，默认停在总览", async () => {
  const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    const top = m.tree.props.children.filter(Boolean);
    assert.equal(top.length, 4, "一级页结构应是：标题行 / 一句话 / tab 条 / 内容，共 4 块");
    const tabbar = top[2];
    assert.equal(tabbar.props.role, "tablist", "tab 条要有 tablist 角色");
    const pills = tabbar.props.children;
    assert.equal(pills.length, 3, "应有三个二级 tab");
    assert.deepEqual(pills.map((p) => p.props.children), ["[tabOverview]", "[tabParams]", "[tabDiag]"]);
    assert.equal(pills[0].props.active, true, "默认选中总览");
    assert.equal(pills[1].props.active, false);
    assert.equal(typeof pills[0].props.onClick, "function", "二级 tab 可点");
    // 默认内容 = 总览
    assert.ok(textOf(m.tree).includes("[whatV]"), "默认应显示总览内容");
    assert.ok(!textOf(m.tree).includes("[pathMode]"), "总览里不该出现参数页的项");
  } finally {
    m.unmount();
  }
});

await t("点二级 tab 能切换：参数 / 诊断 各自的内容出现，总览内容消失", async () => {
  const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    const pill = (label) => findAll(m.tree, (n) => n.type === "button" && textOf(n).includes(label))[0];
    // → 参数
    pill("[tabParams]").props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    let txt = textOf(m.tree);
    assert.ok(txt.includes("[pathMode]") && txt.includes("[placeholder]"), "参数页内容应出现: " + txt.slice(0, 120));
    assert.ok(!txt.includes("[whatV]"), "总览内容应消失");
    assert.equal(findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.active, true, "参数 pill 应变选中");
    // → 诊断
    pill("[tabDiag]").props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    txt = textOf(m.tree);
    assert.ok(txt.includes("[health]") && txt.includes("bytes="), "诊断页内容应出现");
    assert.ok(!txt.includes("[pathMode]"), "参数页内容应消失");
    // → 回到总览
    pill("[tabOverview]").props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(textOf(m.tree).includes("[whatV]"), "能切回总览");
  } finally {
    m.unmount();
  }
});

/* ---------------- ① 总览：一眼看懂"我们是干嘛的" ---------------- */

await t("总览：讲清 干了什么/怎么做的/有什么效果 + 实时统计 + 关键开关 + 保存", async () => {
  const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    const txt = textOf(m.tree);
    for (const must of ["[nav]", "[what]", "[whatV]", "[how]", "[howV]", "[effect]", "[effectV]", "[lede]"]) {
      assert.ok(txt.includes(must), "总览必须说清作用，缺: " + must);
    }
    for (const must of ["[on]", "[sReq]", "[sTok]", "[keepRecent]", "[maxRetries]", "[enable]", "[dryRun]", "[save]"]) {
      assert.ok(txt.includes(must), "总览缺: " + must);
    }
    assert.ok(txt.includes("9") && txt.includes("17"), "统计里应有 chatPosts=9 / imagesDropped=17");
    assert.ok(fetchCalls.length >= 1 && fetchCalls[0].url.endsWith("/_dsh/image-guard"), "应请求同源路由");
  } finally {
    m.unmount();
  }
});

/* ---------------- ② 参数页 ---------------- */

await t("参数页：四个原生开关 + 全部可调项 + 预览 + 重新读取/恢复默认", async () => {
  const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    const txt = textOf(m.tree);
    for (const must of ["[enable]", "[learn]", "[dryRun]", "[verbose]", "[keepRecent]", "[maxRetries]", "[pathMode]", "[matchPath]", "[placeholder]", "[preview]", "[save]", "[reload]", "[reset]"]) {
      assert.ok(txt.includes(must), "参数页缺: " + must);
    }
    const switches = findAll(m.tree, (n) => n.type === "button" && n.props && n.props.role === "switch");
    assert.equal(switches.length, 4, "四个开关应是原生 Switch");
    assert.ok(txt.includes("01-race-start.png"), "预览应可用: " + txt.slice(0, 160));
    // 只允许通用假路径：任何盘符下的**真实**目录都不许出现（断言里也不写本机用户名/盘符）
    const abs = txt.match(/[A-Za-z]:\\[^\s"'`,;)\]]*/g) || [];
    for (const p of abs) assert.ok(p.toLowerCase().startsWith("c:\\path\\to\\"), "文案只允许通用假路径，发现: " + p);
  } finally {
    m.unmount();
  }
});
  await t("标记语言：切到 English 后模板、预览、保存值全为英文", async () => {
    fetchCalls = [];
    const m = mount(mod.ImageGuardSection, { t: (k) => "[" + k + "]" }, mini);
    try {
      await new Promise((r) => setTimeout(r, 10));
      findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.onClick();
      const sel = () => findAll(m.tree, (n) => n.type === "select" && textOf(n).includes("markerZh"))[0];
      const ta = () => findAll(m.tree, (n) => n.type === "textarea")[0];
      const previewText = () => textOf(findAll(m.tree, (n) => n.props && n.props.className === "ig-preview")[0]);
      assert.equal(sel().props.value, "zh", "默认语言应为中文");
      assert.ok(textOf(sel()).includes("[markerZh]") && textOf(sel()).includes("[markerEn]"), "下拉要有两个语言选项");
      assert.ok(textOf(m.tree).includes("[markerLangHint]"), "要有语言说明");
      assert.equal(ta().props.value, "[图片已省略 #{index}{identity}{hint}]", "配置里没模板时按语言回填默认值");
      sel().props.onChange({ target: { value: "en" } });
      assert.equal(sel().props.value, "en", "下拉应切到英文");
      assert.equal(ta().props.value, "[image omitted #{index}{identity}{hint}]", "仍是默认值的模板要跟着换成英文");
      const prev = previewText();
      assert.ok(prev.includes("image omitted"), "预览要用英文模板: " + prev);
      assert.ok(!/[\u4e00-\u9fff]/.test(prev), "英文预览不得含中文: " + prev);
      const saveBtn = findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[save]"))[0];
      saveBtn.props.onClick();
      await new Promise((r) => setTimeout(r, 10));
      const put = fetchCalls.find((c) => c.method === "PUT");
      assert.ok(put, "应发出 PUT");
      const body = JSON.parse(put.body);
      assert.equal(body.markerLang, "en", "保存要带上 markerLang");
      assert.equal(body.placeholder, "[image omitted #{index}{identity}{hint}]");
    } finally {
      m.unmount();
    }
  });

  await t("标记语言：自定义模板不会被切换覆盖", async () => {
    const m = mount(mod.ImageGuardSection, { t: (k) => "[" + k + "]" }, mini);
    try {
      await new Promise((r) => setTimeout(r, 10));
      findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.onClick();
      const sel = () => findAll(m.tree, (n) => n.type === "select" && textOf(n).includes("markerZh"))[0];
      const ta = () => findAll(m.tree, (n) => n.type === "textarea")[0];
      const custom = "[[dropped {index} {name}]]";
      ta().props.onChange({ target: { value: custom } });
      assert.equal(ta().props.value, custom);
      sel().props.onChange({ target: { value: "en" } });
      assert.equal(ta().props.value, custom, "自定义模板必须原样保留");
      sel().props.onChange({ target: { value: "zh" } });
      assert.equal(ta().props.value, custom, "切回中文也不能覆盖");
      const prev = textOf(findAll(m.tree, (n) => n.props && n.props.className === "ig-preview")[0]);
      assert.ok(prev.includes("[[dropped 3 01-race-start.png]]"), "预览要用自定义模板: " + prev);
    } finally {
      m.unmount();
    }
  });

/* ---------------- ③ 诊断页 ---------------- */

await t("诊断页：链路健康 + 统计明细 + 最近请求形态（含 bytes）", async () => {
  const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabDiag]"))[0].props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    const txt = textOf(m.tree);
    for (const must of ["[health]", "[hOwned]", "[hProbe]", "[hPid]", "[hRewrap]", "[uptime]", "[cap]", "[maxSeen]", "[diag]", "url-string", "bytes="]) {
      assert.ok(txt.includes(must), "诊断页缺: " + must);
    }
  } finally {
    m.unmount();
  }
});

await t("诊断页：不在链上时给红色告警 + 重新接管按钮", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: FAKE_CONFIG, status: { ...FAKE_STATUS, fetchOwned: false, probes: 3, probeSeen: 0 } }) });
  try {
    const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
    await new Promise((r) => setTimeout(r, 10));
    findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabDiag]"))[0].props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    const txt = textOf(m.tree);
    assert.ok(txt.includes("[hOwnedNo]"), "应报「未在链上」");
    assert.ok(txt.includes("0 / 3"), "探针 0/3 要显示出来");
    assert.ok(txt.includes("[rewrap]"), "应给重新接管按钮");
    m.unmount();
  } finally {
    globalThis.fetch = orig;
  }
});

await t("总览也会在不在链上时显示红色告警（不用切到诊断页）", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: FAKE_CONFIG, status: { ...FAKE_STATUS, fetchOwned: false } }) });
  try {
    const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
    await new Promise((r) => setTimeout(r, 10));
    const txt = textOf(m.tree);
    assert.ok(txt.includes("[notInChain]"), "总览应直接看到告警: " + txt.slice(0, 160));
    assert.ok(txt.includes("[rewrap]"));
    m.unmount();
  } finally {
    globalThis.fetch = orig;
  }
});

/* ---------------- 交互 ---------------- */

await t("dryRun 打开时状态胶囊变成观察态", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { ...FAKE_CONFIG, dryRun: true }, status: FAKE_STATUS }) });
  try {
    const m = mount(mod.ImageGuardSection, { t: (k) => `[${k}]` }, mini);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(textOf(m.tree).includes("[dry]"), "应为 dryRun 胶囊: " + textOf(m.tree).slice(0, 160));
    m.unmount();
  } finally {
    globalThis.fetch = orig; // 断言失败也必须还原，否则污染后续用例
  }
});

await t("保存会 PUT 到同源路由并带自定义头（总览与参数页共用同一份状态）", async () => {
  fetchCalls = [];
  const m = mount(mod.ImageGuardSection, { t: (k) => `${k}` }, mini);
  try {
    await new Promise((r) => setTimeout(r, 10));
    findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("tabParams"))[0].props.onClick();
    await new Promise((r) => setTimeout(r, 5));
    const saveBtn = findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("save"))[0];
    assert.ok(saveBtn, "找得到保存按钮");
    saveBtn.props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const put = fetchCalls.find((c) => c.method === "PUT");
    assert.ok(put, "应发出 PUT");
    assert.equal(put.headers["X-DSH-Image-Guard"], "1");
    const body = JSON.parse(put.body);
    assert.equal(body.keepRecent, 12);
    assert.equal(body.pathMode, "basename");
    assert.equal(typeof body.enabled, "boolean");
  } finally {
    m.unmount();
  }
});

await t("标记语言默认跟随界面语言：英文界面下模板与预览都不含中文", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { ...FAKE_CONFIG, markerLang: "en", markerLangAuto: true }, status: FAKE_STATUS }) });
    try {
      const m = mount(mod.ImageGuardSection, { t: (k) => "[" + k + "]", ui: () => "en-US" }, mini);
      await new Promise((r) => setTimeout(r, 10));
      findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.onClick();
      const sel = () => findAll(m.tree, (n) => n.type === "select" && textOf(n).includes("markerZh"))[0];
      const ta = () => findAll(m.tree, (n) => n.type === "textarea")[0];
      const prev = () => textOf(findAll(m.tree, (n) => n.props && n.props.className === "ig-preview")[0]);
      assert.equal(sel().props.value, "", "未显式配置时应选中「跟随界面语言」");
      assert.ok(textOf(sel()).includes("[markerAuto]"), "跟随项要在选项里");
      assert.ok(textOf(sel()).includes("[markerEn]"), "跟随项要写明跟到哪种语言");
      assert.equal(ta().props.value, "[image omitted #{index}{identity}{hint}]", "英文界面下默认模板应为英文");
      assert.ok(prev().includes("image omitted"), "预览要用英文: " + prev());
      assert.ok(!/[\u4e00-\u9fff]/.test(prev()), "英文界面预览不得含中文: " + prev());
    } finally {
      globalThis.fetch = orig;
    }
  });

  await t("标记语言跟随态下改选中文 → 预览变中文、保存固定为 zh", async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (u, init) => {
      const method = (init && init.method) || "GET";
      if (method !== "GET") calls.push({ method, body: init && init.body });
      return { ok: true, json: async () => ({ ok: true, config: { ...FAKE_CONFIG, markerLang: "en", markerLangAuto: true }, status: FAKE_STATUS }) };
    };
    try {
      const m = mount(mod.ImageGuardSection, { t: (k) => "[" + k + "]", ui: () => "en" }, mini);
      await new Promise((r) => setTimeout(r, 10));
      findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[tabParams]"))[0].props.onClick();
      const sel = () => findAll(m.tree, (n) => n.type === "select" && textOf(n).includes("markerZh"))[0];
      const ta = () => findAll(m.tree, (n) => n.type === "textarea")[0];
      sel().props.onChange({ target: { value: "zh" } });
      assert.equal(sel().props.value, "zh", "应切到固定中文");
      assert.equal(ta().props.value, "[图片已省略 #{index}{identity}{hint}]", "固定中文后模板应换回中文默认");
      const prev = textOf(findAll(m.tree, (n) => n.props && n.props.className === "ig-preview")[0]);
      assert.ok(prev.includes("图片已省略") && prev.includes("需要时按文件名"), "预览要跟着变中文: " + prev);
      findAll(m.tree, (n) => n.type === "button" && textOf(n).includes("[save]"))[0].props.onClick();
      await new Promise((r) => setTimeout(r, 10));
      const put = calls.find((c) => c.method === "PUT");
      assert.ok(put, "应发出 PUT");
      const body = JSON.parse(put.body);
      assert.equal(body.markerLang, "zh", "固定后要写死 zh");
      assert.equal(body.placeholder, "[图片已省略 #{index}{identity}{hint}]");
    } finally {
      globalThis.fetch = orig;
    }
  });

console.log(`\n通过 ${pass}/${total}`);
process.exit(process.exitCode || 0);