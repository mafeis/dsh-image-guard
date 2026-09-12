// lib/routes.js — 同源设置/状态路由 /_dsh/image-guard
//
// 与 dsh-net-proxy 的 /_dsh/net-proxy 同一套做法：挂在 dsh 的 webServer 上，
// 于是设置页、curl、脚本都能读写同一份配置、看到同一份运行统计。

import { loadConfig, writeConfig, normalize } from "./config.js";

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

/**
 * @param {object} deps { file, getStatus, onChanged }
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function makeHandler({ file, getStatus, onChanged }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const method = String(req.method || "GET").toUpperCase();

      if (method === "GET") {
        return json(res, 200, {
          ok: true,
          config: loadConfig(file),
          status: typeof getStatus === "function" ? getStatus() : null,
          meta: { name: "dsh-image-guard", route: "/_dsh/image-guard", file },
        });
      }

      if (method === "PUT" || method === "POST" || method === "PATCH") {
        const text = await readBody(req);
        let patch = {};
        if (text.trim()) {
          try {
            patch = JSON.parse(text);
          } catch (e) {
            return json(res, 400, { ok: false, error: "body 必须是 JSON: " + e.message });
          }
        }
        // ?reset=1 或空体 → 回到默认值
        const next = url.searchParams.get("reset") === "1" || !text.trim() ? normalize(null) : normalize({ ...loadConfig(file), ...patch });
        const saved = writeConfig(next, file);
        if (typeof onChanged === "function") onChanged(saved);
        return json(res, 200, { ok: true, config: saved });
      }

      return json(res, 405, { ok: false, error: "method not allowed: " + method });
    } catch (err) {
      return json(res, 400, { ok: false, error: (err && err.message) || String(err) });
    }
  };
}
