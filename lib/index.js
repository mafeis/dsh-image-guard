// dsh-image-guard — 服务端 bundle（Node 半边）
//
// 针对两类会导致会话不可用的问题：
//   ① 图片持续累积：agent 的 prompt 为整份对话历史，每查看一次图片即多保留一张；
//      而服务端 --limit-mm-per-prompt.image 按【整个 prompt】计数，累计超限后请求持续返回 400，
//      compact 亦无法规避（压缩发送的是同一份历史），最终会话不可用。
//   ② 已超限的会话：从 400 响应中解析服务端上限，自动降级重试，无需放弃该会话。
//
// 实现方式：包装 globalThis.fetch（与 dsh-net-proxy 同模式，两者可共存、各自向后者链式调用）。
// 详细原理见 README.md。
//
// 模块划分：
//   shapes.js  请求形态判定 + 图片裁剪（纯函数；跨 realm 鸭子类型）
//   decide.js  裁不裁、裁到几张、400 之后怎么降级（纯函数）
//   config.js  配置读写与校验（~/.dsh/image-guard.json）
//   routes.js  /_dsh/image-guard 状态与配置路由
//   index.js   本文件：加载配置、包装 fetch、注册路由、写运行统计

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  urlOf,
  methodOf,
  bodyKindOf,
  inputKindOf,
  readBodyText,
  withBody,
  collectImages,
  partTypeSample,
  stripImages,
} from "./shapes.js";
import { parseImageLimit, nextKeep, effectiveKeep, shouldTrim, shouldGiveUp } from "./decide.js";
import { loadConfig, configPath, normalize } from "./config.js";
import { makeHandler } from "./routes.js";

// schemastery 由宿主提供；解析不到就用普通对象兜底，保证插件永不因缺依赖而加载失败。
let z = null;
try {
  ({ default: z } = await import("@deepseek-ai/schemastery"));
} catch {
  z = null;
}

export const name = "image-guard";
export const inject = [];

const DEFAULTS = normalize(null);

export const Config = z
  ? z
      .object({
        enabled: z.boolean().default(DEFAULTS.enabled),
        keepRecent: z.number().default(DEFAULTS.keepRecent),
        maxRetries: z.number().default(DEFAULTS.maxRetries),
        learnLimit: z.boolean().default(DEFAULTS.learnLimit),
        dryRun: z.boolean().default(DEFAULTS.dryRun),
        matchPath: z.string().default(DEFAULTS.matchPath),
        placeholder: z.string().default(DEFAULTS.placeholder),
        verbose: z.boolean().default(DEFAULTS.verbose),
      })
      .default({})
  : DEFAULTS;

const DIAG_MAX = 40;

export function apply(ctx, config) {
  // 保险：初始化出任何问题都只跳过本插件，绝不影响宿主启动。
  try {
    return applyInner(ctx, config);
  } catch (err) {
    console.error("[image-guard] 初始化失败，已跳过（不影响宿主）:", (err && err.stack) || err);
    return () => {};
  }
}

function applyInner(ctx, config) {
  const file = configPath();
  // patch 里的 config 作为「首次落盘」的初值；之后以 JSON 文件为准（设置页/路由可改）。
  let st = loadConfig(file);
  if (config && typeof config === "object" && Object.keys(config).length && !fs.existsSync(file)) {
    try {
      st = normalize({ ...st, ...config });
    } catch {}
  }
  let pathRe = new RegExp(st.matchPath);
  let learnedLimit = null;

  let base = globalThis.fetch;
  const stat = {
    pid: process.pid, // 多进程时用来判断"这份状态是谁写的"
    startedAt: new Date().toISOString(),
    chatPosts: 0, // 见到的 chat POST 总数（含无图的）
    bundled: 0, // 其中带图的
    trimmed: 0, // 发生过裁剪的请求数
    imagesDropped: 0, // 累计裁剪张数
    tokensSaved: 0, // 累计省下的视觉 token（估算：每张 tokensPerImage - 标记开销）
    retried: 0, // 400 降级重试次数
    learnedLimit: null, // 学到的服务端上限
    maxSeen: 0, // 单请求见过的最大图片数
    dryRunSkips: 0, // dryRun 下本该裁但没裁的次数
    last: null, // 最近一次终态
    diag: [], // 最近 40 条 chat POST 的形态
    // —— 自检：本进程的 fetch 现在到底还是不是我的？请求真的会经过我吗？——
    fetchOwned: null, // globalThis.fetch === guardedFetch ?
    rewraps: 0, // 被别人覆盖后重新接管的次数
    fetchStolen: false, // 反复被抢，已放弃自愈（避免与他人无限互相包装）
    probes: 0, // 自发探针次数
    probeSeen: 0, // 其中真的从我的守卫里穿过的次数（==0 说明我不在链上）
  };

  const statusFile = process.env.DSH_IMAGE_GUARD_STATUS || path.join(os.homedir(), ".dsh", "image-guard-status.json");
  let dirty = false;
  let timer = null;
  function flush(force = false) {
    if (!dirty && !force) return;
    dirty = false;
    try {
      fs.writeFileSync(statusFile, JSON.stringify({ ...stat, config: st, learnedLimit }, null, 1), "utf8");
    } catch {}
  }
  function touch(patch) {
    Object.assign(stat, patch);
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, 800);
      timer.unref?.();
    }
  }
  const log = (...a) => {
    if (st.verbose) console.error("[image-guard]", ...a);
  };

  /* ---------------- fetch 守卫 ---------------- */

  async function guardedFetch(input, init) {
    // 自发探针：只证明"我这个包装是否真的在链上"，绝不外发
    const hdrs = init?.headers;
    if (hdrs && (hdrs["x-image-guard-probe"] || hdrs["X-Image-Guard-Probe"])) {
      touch({ probeSeen: stat.probeSeen + 1, fetchOwned: globalThis.fetch === guardedFetch });
      return new Response(JSON.stringify({ ok: true }), { status: 204, headers: { "content-type": "application/json" } });
    }

    // 发出过一次就绝不重发：避免把一次中断变成两次请求
    let dispatched = false;
    const send = (i, init2) => {
      dispatched = true;
      return base(i, init2);
    };

    try {
      const url = urlOf(input);
      const method = methodOf(input, init); // ← 鸭子类型，见 shapes.js 顶部注释
      if (!st.enabled || method !== "POST" || !pathRe.test(url)) return send(input, init);

      const inputKind = inputKindOf(input);
      const bodyKind = bodyKindOf(init);
      const put = (rec) => {
        const diag = stat.diag.slice(-(DIAG_MAX - 1));
        diag.push({ at: new Date().toISOString().slice(11, 19), input: inputKind, body: bodyKind, ...rec });
        touch({ diag, chatPosts: stat.chatPosts + 1 });
      };

      const raw = await readBodyText(input, init);
      if (raw == null) {
        put({ path: url.slice(-32), read: false });
        return send(input, init);
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        put({ path: url.slice(-32), read: true, json: false, bytes: raw.length });
        return send(input, init);
      }

      const images = collectImages(body);
      put({
        path: url.slice(-32),
        read: true,
        json: true,
        bytes: raw.length, // 请求体字节数：图片是内联 base64，所以这里是 MB 级（不是"地址"）
        msgs: body?.messages?.length ?? 0,
        imgs: images.length,
        parts: partTypeSample(body),
      });
      if (images.length === 0) return send(input, init);

      touch({ bundled: stat.bundled + 1, maxSeen: Math.max(stat.maxSeen, images.length) });

      let keep = effectiveKeep(st.keepRecent, learnedLimit);
      let attempt = 0;
      for (;;) {
        const trim = shouldTrim(images.length, keep);
        let payload = body;
        let dropped = 0;
        if (trim) {
          const r = stripImages(body, keep, st.placeholder, { pathMode: st.pathMode });
          dropped = r.dropped;
          if (st.dryRun) {
            if (attempt === 0 && dropped > 0) {
              touch({ dryRunSkips: stat.dryRunSkips + 1 });
              log(`dryRun：本次本应裁剪 ${dropped} 张（${images.length} → ${images.length - dropped}）`);
            }
          } else {
            payload = r.payload;
            if (attempt === 0 && dropped > 0) {
              // tokensSaved 是**估算**：每张被替换的图按 tokensPerImage（默认 972 = 该路由实测上限）计，
              // 再扣掉标记本身的文本开销（≈每处 40 token）。标记里的数字由用户自己核对。
              const markCost = dropped * 40;
              const saved = Math.max(0, dropped * (st.tokensPerImage || 0) - markCost);
              touch({ trimmed: stat.trimmed + 1, imagesDropped: stat.imagesDropped + dropped, tokensSaved: stat.tokensSaved + saved });
              log(`历史图片裁剪：${images.length} → ${images.length - dropped} 张（保留最近 ${keep}），本轮约节省 ${saved} token`);
            }
          }
        }

        const sent =
          dropped > 0 && !st.dryRun ? await send(...withBody(input, init, JSON.stringify(payload))) : await send(input, init);

        if (shouldGiveUp(sent.status, attempt, st.maxRetries) || !st.learnLimit || st.dryRun) {
          if (attempt > 0) touch({ last: { at: new Date().toISOString(), result: sent.status, attempt, kept: keep } });
          return sent;
        }

        const text = await sent.clone().text().catch(() => "");
        const limit = parseImageLimit(text);
        if (limit == null) {
          // 不是图片上限问题：原样交回，但记下来（便于事后判断是不是别的 400）
          touch({ last: { at: new Date().toISOString(), result: sent.status, attempt, note: text.slice(0, 160) } });
          return sent;
        }

        attempt++;
        learnedLimit = limit;
        const nk = nextKeep(limit, keep);
        touch({ retried: stat.retried + 1, learnedLimit: limit });
        log(`服务端 image 上限=${limit}，降级到保留 ${nk} 张后重试（第 ${attempt} 次）`);
        keep = nk;
        if (attempt >= st.maxRetries) return sent;
      }
    } catch (err) {
      if (dispatched) throw err; // 上游/中断错误：原样抛给调用方，绝不重发
      log("守卫异常，按原样放行：", err && err.message);
      return base(input, init);
    }
  }

  /* ---------------- 接手与自检 ----------------
   * 插件的唯一命门是「我的包装真的在 globalThis.fetch 链上」。
   * 实测现象：宿主某次启动后包装已安装（状态文件亦已写出），但 LLM 请求未经过它
   * ——「加载了」不等于「在链上」。所以这里既主动验证（探针），也自愈（被顶掉就重新接管）。
   */

  /** 把守卫重新挂到链首（保留当前链首作为 base，不破坏别人的包装）。 */
  function rewrap(reason) {
    if (globalThis.fetch === guardedFetch) {
      touch({ fetchOwned: true });
      return false;
    }
    const stolen = globalThis.fetch;
    if (stat.rewraps >= 5) {
      touch({ fetchOwned: false, fetchStolen: true });
      log(`fetch 被反复接管，已放弃自愈（避免与人无限互相包装）：${String(stolen && stolen.name)}`);
      return false;
    }
    base = stolen;
    globalThis.fetch = guardedFetch;
    touch({ fetchOwned: true, rewraps: stat.rewraps + 1 });
    log(`fetch 被他人覆盖（${String(stolen && stolen.name)}），已重新接管（${reason}），累计 ${stat.rewraps + 1} 次`);
    return true;
  }

  /** 自发探针：连自己发的请求都不经过守卫 ⇒ 本进程的请求不走 globalThis.fetch。 */
  function selfProbe() {
    touch({ probes: stat.probes + 1 });
    try {
      Promise.resolve(
        globalThis.fetch("http://127.0.0.1:9/_dsh-probe/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-image-guard-probe": "1" },
          body: "{}",
        }),
      ).catch(() => {});
    } catch {}
  }

  guardedFetch.__dshImageGuard = true;
  globalThis.fetch = guardedFetch;
  stat.fetchOwned = true;

  const timers = [];
  try {
    const t = setTimeout(() => {
      rewrap("load+3s");
      selfProbe();
    }, 3000);
    t.unref?.();
    timers.push(t);
    // 1s 一次身份检查（极廉）：net-proxy 在系统代理变动时会重新安装到链首，
    // 而它【走代理时用自带 socket，绕过链下层的所有 fetch 包装器】——不抢回链首就等于守卫失效。
    const iv = setInterval(() => {
      rewrap("watchdog");
      if (stat.probes < 3) selfProbe();
    }, 1000);
    iv.unref?.();
    timers.push(iv);
  } catch {}

  /* ---------------- 配置热更 ---------------- */

  function applyConfig(next) {
    st = normalize(next);
    pathRe = new RegExp(st.matchPath);
    log(`配置已更新：keepRecent=${st.keepRecent} maxRetries=${st.maxRetries} dryRun=${st.dryRun} enabled=${st.enabled}`);
  }
  function reloadFrom(f) {
    try {
      const next = loadConfig(f);
      if (JSON.stringify(next) !== JSON.stringify(st)) applyConfig(next);
    } catch (err) {
      log("配置热更失败：", err && err.message);
    }
  }
  const watchers = [];
  try {
    if (fs.existsSync(file)) {
      const w = fs.watch(file, (evt) => {
        if (evt === "rename") return;
        reloadFrom(file);
      });
      w.on("error", () => {});
      watchers.push(w);
    }
  } catch {}

  /* ---------------- 同源设置/状态路由 ---------------- */

  ctx?.inject?.(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const inner = makeHandler({
        file,
        getStatus: () => ({ ...stat, config: st, learnedLimit }),
        onChanged: (saved) => applyConfig(saved),
      });
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/_dsh/image-guard",
        handler: (req, res) => {
          // POST /_dsh/image-guard?rewrap=1 —— 手动要求守卫重新接管 fetch（排障用，免重启）
          const url = String(req?.url || "");
          if (req?.method === "POST" && url.includes("rewrap=")) {
            const took = rewrap("route");
            selfProbe();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, took, status: { ...stat, config: st, learnedLimit } }));
            return;
          }
          return inner(req, res);
        },
      });
      console.error("[image-guard] 同源设置路由: /_dsh/image-guard");
      return dispose;
    }, "image-guard: web settings route");
  });

  // 调试/测试句柄：本进程里守卫的自检与自愈入口
  try {
    globalThis[Symbol.for("dsh-image-guard")] = {
      rewrap,
      selfProbe,
      guardedFetch,
      stat, // 活引用（调试/测试用，可改；status() 给的是快照）
      status: () => ({ ...stat, config: st, learnedLimit }),
    };
  } catch {}

  flush(true); // 加载即写出状态文件，便于直接确认插件是否生效（无需等待首个含图请求）
  console.error(
    `[image-guard] 已启用：保留最近 ${st.keepRecent} 张图片；上游返回 400 时自动降级（最多 ${st.maxRetries} 次）` +
      `${st.dryRun ? "（dryRun 仅观察，不修改请求）" : ""}；pid=${process.pid}；配置文件 ${file}`,
  );

  return () => {
    for (const t2 of timers) {
      try {
        clearTimeout(t2);
        clearInterval(t2);
      } catch {}
    }
    try {
      delete globalThis[Symbol.for("dsh-image-guard")];
    } catch {}
    globalThis.fetch = base;
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
    if (timer) clearTimeout(timer);
    flush();
  };
}
