// dsh-image-guard — 浏览器 client-plugin（exports "./client"）
// 设置页：直连 dsh 同源路由 /_dsh/image-guard，读写配置并展示运行统计。
// 免构建：手写 window.__ModuleLoader__ + react/jsx-runtime，控件用 DSH 原生原子。
//
// 版面纪律（用户定稿）：
//   **只注册一个一级菜单**「图片守卫」，页内用原生 Pill 实现三个二级 tab——
//     总览：功能 / 实现 / 效果 + 实时统计 + 关键开关
//     参数：全部可调项
//     诊断：链路状态、统计明细、最近请求形态（未拦截时查看）
window.__ModuleLoader__.load({
	id: "dsh-image-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var jx = require("react/jsx-runtime");
		var Prm = require("@deepseek-ai/dsh-client-ui-primitives");
		var Button = Prm.Button;
		var Pill = Prm.Pill;
		var Switch = Prm.Switch;
		var Tag = Prm.Tag;

		var css = [
			".ig-root{display:flex;flex-direction:column;gap:10px}",
			".ig-head{display:flex;align-items:center;justify-content:space-between;gap:10px}",
			".ig-title{font-size:16px;font-weight:650;margin:0;color:var(--dsw-alias-label-primary)}",
			".ig-lede{font-size:12.5px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}",
			".ig-tabs{display:flex;align-items:center;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2f3a)}",
			".ig-card{border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,#1a1e26);display:flex;flex-direction:column;gap:10px}",
			".ig-kv{display:grid;grid-template-columns:76px 1fr;gap:6px 10px;font-size:12px;line-height:1.65;margin:0}",
			".ig-kv dt{color:var(--dsw-alias-label-tertiary);margin:0}",
			".ig-kv dd{margin:0;color:var(--dsw-alias-label-secondary)}",
			".ig-kv dd b{color:var(--dsw-alias-label-primary);font-weight:600}",
			".ig-ctl{display:flex;align-items:center;gap:14px;flex-wrap:wrap}",
			".ig-sw{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-primary);white-space:nowrap}",
			".ig-num{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".ig-num input{width:70px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#12151b);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:6px;padding:4px 6px;font:inherit;font-size:12.5px}",
			".ig-stats{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.8;font-variant-numeric:tabular-nums}",
			".ig-stats b{color:var(--dsw-alias-label-primary);font-weight:600}",
			".ig-stats i{font-style:normal;opacity:.5;margin:0 6px}",
			".ig-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".ig-msg{font-size:11.5px}",
			".ig-msg.ok{color:var(--dsw-alias-state-success-primary,#2ecc71)}",
			".ig-msg.err{color:var(--dsw-alias-state-error-primary,#e74c3c)}",
			".ig-warn{font-size:12px;line-height:1.55;color:var(--dsw-alias-state-error-primary,#e74c3c);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e74c3c) 10%,transparent);border-radius:8px;padding:8px 10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".ig-field{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;align-items:center;margin:0}",
			".ig-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".ig-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;grid-column:2;margin:0}",
			".ig-in{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#12151b);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2,#2a2f3a);border-radius:6px;padding:5px 8px;font:inherit;font-size:12px}",
			".ig-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
			".ig-preview{padding:7px 9px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#12151b);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-all;grid-column:2}",
			".ig-preview em{font-style:normal;color:var(--dsw-alias-label-tertiary);margin-right:5px}",
			".ig-diag{display:flex;flex-direction:column;gap:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;max-height:220px;overflow:auto}",
			".ig-diag-row{display:grid;grid-template-columns:58px 74px 62px 1fr;gap:8px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".ig-diag-head{color:var(--dsw-alias-label-secondary);font-weight:600}",
			".ig-diag-row b{color:var(--dsw-alias-label-secondary);font-weight:500}",
			".ig-hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,#2a2f3a);margin:2px 0}",
		].join("");

		var NS = "image-guard";
		var API = "/_dsh/image-guard";
		var HDR = { "Content-Type": "application/json", "X-DSH-Image-Guard": "1" };

		var zh = {
			nav: "图片守卫",
			tabOverview: "总览",
			tabParams: "参数",
			tabDiag: "诊断",
			lede: "在请求发送前将历史图片裁剪至预算内，避免含图会话因上游图片数量限制持续返回 400，并降低每轮视觉 token 消耗。",
			what: "功能",
			how: "实现",
			effect: "效果",
			whatV: "在请求发送前将历史图片替换为可识别标记（文件名 / 路径 / 指纹及取回方式）；对已超出上游上限的会话自动降级恢复，避免会话不可用。",
			howV: "包装 globalThis.fetch，仅处理「POST + 聊天补全路径 + 含图片」的 JSON 请求：保留最新 N 张，其余替换为标记；上游仍返回 At most N image(s) 时解析其上限并降级重发。",
			effectV: "每张被裁剪的图片约省 972 视觉 token（实测上限，扣除标记开销约 40）；14 张裁剪至 7 张约每轮省 6.5k token，且仅需一次 400 重试后即稳定。",
			on: "已启用",
			off: "已关闭",
			loading: "读取中…",
			unreachable: "服务不可达",
			dry: "dryRun 观察中",
			enable: "启用",
			learn: "学习上限",
			verbose: "日志",
			dryRun: "dryRun（仅观察，不修改请求）",
			keepRecent: "保留最近几张图",
			keepRecentHint: "保留最新的 N 张，更早的替换为标记；0 表示全部替换。",
			maxRetries: "降级重试次数",
			maxRetriesHint: "上游返回 400 后的最大降级重发次数。",
			matchPath: "生效路径",
			matchPathHint: "正则；仅匹配的 POST 请求会被处理，默认为聊天补全路径。",
			pathMode: "路径显示",
			pathModeHint: "标记会随请求发送至服务端；默认仅文件名，不泄露本机目录结构。",
			placeholder: "省略标记模板",
			placeholderHint: "可用占位符 {index} {name} {path} {id} {mime} {dims} {size} {identity} {hint}；{total}/{kept} 会导致前缀缓存失效。留空时服务端用中文默认模板。",
			markerLang: "标记语言",
			markerLangHint: "决定默认模板与标记正文（身份、取回提示）的语言；默认跟随应用界面语言，选中具体语言后固定不变，切换时会把仍是默认值的模板一起换掉。",
			markerAuto: "跟随界面语言",
			markerZh: "中文",
			markerEn: "English",
			preview: "预览",
			pmFull: "完整绝对路径",
			pmRelative: "相对工作区（或 ~）",
			pmBasename: "仅文件名（推荐）",
			pmNone: "不显示路径",
			save: "保存并应用",
			saved: "已保存并生效",
			saveFailed: "保存失败，请检查输入",
			reload: "重新读取",
			reset: "恢复默认",
			cfgFile: "配置存在 ~/.dsh/image-guard.json，改动热更、免重启。",
			sReq: "请求",
			sImg: "带图",
			sTrim: "裁剪",
			sRetry: "重试",
			sCap: "上限",
			sNow: "本次发送",
			sTok: "已省",
			sTokTip: "累计节省的视觉 token（估算：每张按实测上限 972 计算，并扣除标记开销）",
			sTokUnit: "tok",
			health: "链路状态",
			hOwned: "守卫已接入 fetch 链",
			hOwnedNo: "未接入链（请求将绕过守卫）",
			hProbe: "链上探针",
			hPid: "进程",
			hRewrap: "重新接入次数",
			rewrap: "重新接入",
			notInChain: "注意：守卫未接入 fetch 链，本进程的请求不会经过它，图片将原样发出。",
			uptime: "运行时长",
			cap: "学到的服务端上限",
			maxSeen: "单请求最多图",
			drySkips: "本会裁的次数（dry）",
			diag: "最近请求形态（未拦截时查看）",
			diagEmpty: "暂无记录",
			diagHint: "「读不到」表示请求体非 JSON（已原样放行）；形态不符合预期说明未被拦截。bytes 为请求体字节数，达到 MB 级说明图片以内联字节形式发送。",
			readFalse: "读不到",
		};
		var en = {
			nav: "Image Guard",
			tabOverview: "Overview",
			tabParams: "Settings",
			tabDiag: "Diagnostics",
			lede: "Trims historical images to a budget before each request, preventing image-heavy sessions from failing on the provider image cap and reducing vision-token usage.",
			what: "Function",
			how: "Implementation",
			effect: "Effect",
			whatV: "Replaces historical images with identifiable markers (file name / path / fingerprint and how to retrieve them) and recovers sessions that already exceeded the provider cap.",
			howV: "Wraps globalThis.fetch and handles only JSON requests that are POST, match the chat path and contain images: the newest N images are kept and the rest are replaced by markers; if the provider still returns 'At most N image(s)', the cap is parsed and the request is retried with fewer images.",
			effectV: "Each trimmed image saves ~972 vision tokens (measured cap, minus ~40 marker cost); trimming 14 images to 7 saves ~6.5k tokens per turn, and only one 400 retry is needed before requests stabilise.",
			on: "Enabled",
			off: "Off",
			loading: "Loading…",
			unreachable: "Service unreachable",
			dry: "dryRun",
			enable: "Enable",
			learn: "Learn cap",
			verbose: "Logs",
			dryRun: "dryRun (observe only)",
			keepRecent: "Keep newest N images",
			keepRecentHint: "Older images are replaced by markers; 0 replaces all images.",
			maxRetries: "Downgrade retries",
			maxRetriesHint: "Maximum number of downgrade retries after a 400 response.",
			matchPath: "Paths",
			matchPathHint: "Regular expression; only matching POST requests are handled.",
			pathMode: "Path detail",
			pathModeHint: "The marker is sent to the provider; file name only by default.",
			placeholder: "Marker template",
			placeholderHint: "Placeholders: {index} {name} {path} {id} {mime} {dims} {size} {identity} {hint}; {total}/{kept} invalidate the prefix cache. Empty uses the Chinese default.",
			markerLang: "Marker language",
			markerLangHint: "Sets the language of the default template and of the marker body (identity and retrieval hint). It follows the app interface language by default; picking a language pins it. Switching also replaces a template that is still a default.",
			markerAuto: "Follow the interface language",
			markerZh: "Chinese",
			markerEn: "English",
			preview: "Preview",
			pmFull: "Full absolute path",
			pmRelative: "Relative to workspace (or ~)",
			pmBasename: "File name only (recommended)",
			pmNone: "No path",
			save: "Save & apply",
			saved: "Saved & applied",
			saveFailed: "Save failed",
			reload: "Reload",
			reset: "Reset",
			cfgFile: "Config lives in ~/.dsh/image-guard.json; edits apply live, no restart.",
			sReq: "requests",
			sImg: "with images",
			sTrim: "trimmed",
			sRetry: "retried",
			sCap: "cap",
			sNow: "sending",
			sTok: "saved",
			sTokTip: "Estimated vision tokens saved (per image at the measured cap of 972, minus marker cost).",
			sTokUnit: "tok",
			health: "Chain status",
			hOwned: "Guard is attached to the fetch chain",
			hOwnedNo: "Not attached (requests bypass the guard)",
			hProbe: "In-chain probes",
			hPid: "Process",
			hRewrap: "Re-attach count",
			rewrap: "Re-attach",
			notInChain: "Note: the guard is not attached to the fetch chain in this process, so requests bypass it and images are sent as-is.",
			uptime: "Uptime",
			cap: "Learned provider cap",
			maxSeen: "Max images seen",
			drySkips: "Would-trim (dry)",
			diag: "Recent request shapes (check here when a request is not intercepted)",
			diagEmpty: "no entries yet",
			diagHint: "'unreadable' means the body was not JSON (passed through). A shape that does not match the expectation means the request was not intercepted. 'bytes' is the request body size; a size in the MB range confirms inline image bytes.",
			readFalse: "unreadable",
		};

		/* ---------------- 小部件（控件全部用 DSH 原生原子） ---------------- */

		function Sw(props) {
			return jx.jsx("label", { className: "ig-sw", children: [jx.jsx(Switch, { checked: Boolean(props.checked), label: props.label, onChange: props.onChange }), jx.jsx("span", { children: props.label })] });
		}
		function Num(props) {
			return jx.jsx("label", {
				className: "ig-num",
				children: [
					jx.jsx("span", { children: props.label }),
					jx.jsx("input", { type: "number", value: props.value, onChange: function (e) { props.onChange(e.target.value); } }),
				],
			});
		}
		function Field(props) {
			return jx.jsx("label", {
				className: "ig-field",
				children: [
					jx.jsx("span", { className: "ig-field-label", children: props.label }),
					props.children,
					props.hint ? jx.jsx("small", { className: "ig-field-hint", children: props.hint }) : null,
				],
			});
		}
		function Row(props) {
			return jx.jsx("div", { className: "ig-line", children: props.children });
		}

		/** 42917 → "42.9k" */
		function fmtTokens(n) {
			var v = Number(n) || 0;
			if (v < 1000) return String(v);
			if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "k";
			return (v / 1000000).toFixed(1) + "M";
		}
		function fmtUptime(startedAt) {
			var s = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
			if (!isFinite(s)) return "—";
			if (s < 60) return s + "s";
			if (s < 3600) return Math.floor(s / 60) + "m" + Math.floor(s % 60) + "s";
			return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
		}

		// 预览样例只放**通用假路径**：插件要发布到市场，绝不含作者/用户的真实目录
		var SAMPLE_BASE = { index: "3", total: "14", kept: "12", name: "01-race-start.png", url: "https://example.com/shots/01-race-start.png", id: "sha1:bf23bcd3", mime: "image/png", dims: "1280x720", size: "618 KiB" };
		// 标记语言：服务端按 markerLang 同时决定默认模板**和**标记正文（身份、取回提示），
		// 所以这里的样例文字必须与 lib/shapes.js 的 MARKER_TEXT 逐字一致，预览才不会骗人。
		var MARKER_TEMPLATE = { zh: "[图片已省略 #{index}{identity}{hint}]", en: "[image omitted #{index}{identity}{hint}]" };
		var SAMPLE_TEXT = {
			zh: {
				imageLabel: "图片 ",
				hintRead: " · 需要时用 read_image 重新读取",
				hintSearch: " · 需要时按文件名在工作区内搜索后读取",
				hintHidden: " · 路径已按配置隐去",
			},
			en: {
				imageLabel: "image ",
				hintRead: " · read it again with read_image",
				hintSearch: " · search the workspace by file name to read it again",
				hintHidden: " · path hidden by configuration",
			},
		};
		function samplesFor(mode, lang) {
			var T = SAMPLE_TEXT[lang === "en" ? "en" : "zh"];
			var m = mode === "full" || mode === "relative" || mode === "none" ? mode : "basename";
			if (m === "full") return { path: "C:\\path\\to\\shots\\01-race-start.png", identity: " · C:\\path\\to\\shots\\01-race-start.png", hint: T.hintRead };
			if (m === "relative") return { path: "shots/01-race-start.png", identity: " · shots/01-race-start.png", hint: T.hintRead };
			if (m === "none") return { path: "", identity: " · " + T.imageLabel + "sha1:bf23bcd3 (image/png 1280x720 618 KiB)", hint: T.hintHidden };
			return { path: "01-race-start.png", identity: " · 01-race-start.png", hint: T.hintSearch };
		}
		/** 界面语言归一：宿主 locale 形如 zh / zh-CN / en / en-US */
		function normLang(x) {
			return /^en/i.test(String(x || "")) ? "en" : "zh";
		}
		/** 生效的标记语言：配置里写了 zh/en 就用它，否则跟随界面语言 */
		function effLang(sel, uiLang) {
			return sel === "zh" || sel === "en" ? sel : normLang(uiLang);
		}
		function defaultTemplate(lang) {
			return lang === "en" ? MARKER_TEMPLATE.en : MARKER_TEMPLATE.zh;
		}
		function previewMarker(tpl, mode, lang) {
			var sel = samplesFor(mode, lang);
			var s = typeof tpl === "string" && tpl ? tpl : defaultTemplate(lang);
			return s.replace(/\{(\w+)\}/g, function (m, k) {
				if (Object.prototype.hasOwnProperty.call(sel, k)) return sel[k];
				return Object.prototype.hasOwnProperty.call(SAMPLE_BASE, k) ? SAMPLE_BASE[k] : m;
			});
		}

		/* ---------------- 共享状态：三个二级 tab 共用一份（切 tab 不丢未保存改动、不重复拉取） ---------------- */

		function useGuard(uiLang) {
			var [ready, setReady] = React.useState(false);
			var [unreachable, setUnreachable] = React.useState(false);
			var [applied, setApplied] = React.useState(false);
			var [saveErr, setSaveErr] = React.useState(false);
			var [status, setStatus] = React.useState(null);
			var [enabled, setEnabled] = React.useState(true);
			var [learnLimit, setLearnLimit] = React.useState(true);
			var [verbose, setVerbose] = React.useState(true);
			var [dryRun, setDryRun] = React.useState(false);
			var [keepRecent, setKeepRecent] = React.useState("12");
			var [maxRetries, setMaxRetries] = React.useState("3");
			var [pathMode, setPathMode] = React.useState("basename");
			var [matchPath, setMatchPath] = React.useState("/chat/completions|/messages");
			var [placeholder, setPlaceholder] = React.useState("");
			var [markerLang, setMarkerLang] = React.useState("");

			function applyValue(v) {
				if (!v || typeof v !== "object") return;
				setEnabled(v.enabled !== false);
				setLearnLimit(v.learnLimit !== false);
				setVerbose(v.verbose !== false);
				setDryRun(v.dryRun === true);
				setKeepRecent(v.keepRecent != null ? String(v.keepRecent) : "12");
				setMaxRetries(v.maxRetries != null ? String(v.maxRetries) : "3");
				setPathMode(v.pathMode || "basename");
				setMatchPath(v.matchPath || "/chat/completions|/messages");
				// 服务端给的是「生效值 + 是否跟随」：跟随态要还原成空字符串，别把跟随变成固定
				var sel = v.markerLangAuto === true || (v.markerLang !== "zh" && v.markerLang !== "en") ? "" : v.markerLang;
				setMarkerLang(sel);
				setPlaceholder(v.placeholder || defaultTemplate(effLang(sel, uiLang)));
			}
			// 切换标记语言：模板仍是任一语言的默认值（或为空）时跟着换，自定义模板原样保留。
			function pickMarkerLang(next) {
				var to = next === "zh" || next === "en" ? next : ""; // "" = 跟随界面语言
				setMarkerLang(to);
				setPlaceholder(function (cur) {
					var isDefault = !cur || cur === MARKER_TEMPLATE.zh || cur === MARKER_TEMPLATE.en;
					return isDefault ? defaultTemplate(effLang(to, uiLang)) : cur;
				});
				setApplied(false); // 等价于导出对象上的 dirty()：标记为未保存
			}

			function load(silent) {
				fetch(API)
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (!j || !j.ok) { if (!silent) setUnreachable(true); return; }
						applyValue(j.config);
						if (j.status) setStatus(j.status);
						setReady(true);
						setUnreachable(false);
					})
					.catch(function () { if (!silent) setUnreachable(true); });
			}
			React.useEffect(function () { load(false); }, []);
			// 统计随 agent 请求变化：定时静默刷新（只更新 status，绝不碰表单）
			React.useEffect(function () {
				var iv = setInterval(function () {
					fetch(API).then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok && j.status) setStatus(j.status); }).catch(function () {});
				}, 5000);
				return function () { clearInterval(iv); };
			}, []);

			function save() {
				setSaveErr(false); setApplied(false);
				fetch(API, {
					method: "PUT",
					headers: HDR,
					body: JSON.stringify({
						enabled: Boolean(enabled), learnLimit: Boolean(learnLimit), verbose: Boolean(verbose), dryRun: Boolean(dryRun),
						keepRecent: Number(keepRecent), maxRetries: Number(maxRetries),
						pathMode: pathMode, matchPath: matchPath, placeholder: placeholder, markerLang: markerLang,
					}),
				})
					.then(function (r) { return r.json(); })
					.then(function (j) {
						if (j && j.ok) { applyValue(j.config); setApplied(true); setReady(true); setUnreachable(false); load(true); }
						else setSaveErr(true);
					})
					.catch(function () { setSaveErr(true); });
			}
			function reloadNow() { setApplied(false); setSaveErr(false); load(false); }
			function resetNow() {
				setApplied(false); setSaveErr(false);
				fetch(API + "?reset=1", { method: "POST", headers: HDR })
					.then(function (r) { return r.json(); })
					.then(function (j) { if (j && j.ok) { applyValue(j.config); setApplied(true); load(true); } else setSaveErr(true); })
					.catch(function () { setSaveErr(true); });
			}
			function rewrapNow() {
				fetch(API + "?rewrap=1", { method: "POST", headers: HDR })
					.then(function (r) { return r.json(); })
					.then(function (j) { if (j && j.status) setStatus(j.status); else load(true); })
					.catch(function () {});
			}

			var keepNum = Number(keepRecent);
			var configured = isFinite(keepNum) ? keepNum : 12;
			var learned = status && status.learnedLimit != null ? Number(status.learnedLimit) : null;
			return {
				ready: ready, unreachable: unreachable, applied: applied, saveErr: saveErr, status: status,
				enabled: enabled, setEnabled: setEnabled, learnLimit: learnLimit, setLearnLimit: setLearnLimit,
				verbose: verbose, setVerbose: setVerbose, dryRun: dryRun, setDryRun: setDryRun,
				keepRecent: keepRecent, setKeepRecent: setKeepRecent, maxRetries: maxRetries, setMaxRetries: setMaxRetries,
				pathMode: pathMode, setPathMode: setPathMode, matchPath: matchPath, setMatchPath: setMatchPath,
				placeholder: placeholder, setPlaceholder: setPlaceholder, markerLang: markerLang, setMarkerLang: pickMarkerLang, effLang: effLang(markerLang, uiLang), markerAuto: !markerLang, uiLang: normLang(uiLang),
				save: save, reloadNow: reloadNow, resetNow: resetNow, rewrapNow: rewrapNow,
				learned: learned, now: learned != null ? Math.min(configured, Math.max(0, learned - 1)) : configured,
				dirty: function () { setApplied(false); },
			};
		}

		function StatusTag(props) {
			var g = props.g, t = props.t;
			var b = g.unreachable ? [t("unreachable"), "warning"] : !g.ready ? [t("loading"), "neutral"] : g.dryRun ? [t("dry"), "info"] : g.enabled ? [t("on"), "success"] : [t("off"), "neutral"];
			return jx.jsx(Tag, { tone: b[1], children: b[0] });
		}

		function SaveRow(props) {
			var g = props.g, t = props.t;
			return jx.jsx(Row, {
				children: [
					jx.jsx(Button, { variant: "primary", size: "sm", disabled: g.unreachable, onClick: g.save, children: t("save") }),
					g.applied ? jx.jsx("span", { className: "ig-msg ok", children: t("saved") }) : null,
					g.saveErr ? jx.jsx("span", { className: "ig-msg err", children: t("saveFailed") }) : null,
				],
			});
		}

		function Stats(props) {
			var g = props.g, t = props.t, s = g.status;
			var seps = jx.jsx("i", { children: "·" });
			var one = function (label, value) { return jx.jsx("span", { children: [label + " ", jx.jsx("b", { children: value })] }); };
			return jx.jsx("div", {
				className: "ig-stats",
				children: [
					one(t("sReq"), s && s.chatPosts != null ? s.chatPosts : "—"), seps,
					one(t("sImg"), s && s.bundled != null ? s.bundled : "—"), seps,
					one(t("sTrim"), (s && s.trimmed ? s.trimmed : 0) + "/" + (s && s.imagesDropped ? s.imagesDropped : 0)), seps,
					one(t("sRetry"), s && s.retried != null ? s.retried : 0), seps,
					one(t("sCap"), g.learned != null ? g.learned : "—"), seps,
					one(t("sNow"), g.now), seps,
					jx.jsx("span", { title: t("sTokTip"), children: [t("sTok") + " ", jx.jsx("b", { children: fmtTokens(s && s.tokensSaved ? s.tokensSaved : 0) }), " " + t("sTokUnit")] }),
				],
			});
		}

		/* ---------------- 二级 tab ① 总览 ---------------- */

		function OverviewTab(props) {
			var t = props.t, g = props.g;
			var line = function (k, v) {
				return [jx.jsx("dt", { key: k + "-k", children: t(k) }), jx.jsx("dd", { key: k + "-v", children: t(v) })];
			};
			return jx.jsx("div", {
				className: "ig-root",
				children: [
					jx.jsx("div", {
						className: "ig-card",
						children: [
							jx.jsx("dl", { className: "ig-kv", children: [].concat(line("what", "whatV"), line("how", "howV"), line("effect", "effectV")) }),
							jx.jsx("hr", { className: "ig-hr" }),
							jx.jsx(Stats, { g: g, t: t }),
						],
					}),
					g.status && g.status.fetchOwned === false
						? jx.jsx("div", { className: "ig-warn", children: [jx.jsx("span", { children: t("notInChain") }), jx.jsx(Button, { variant: "outline", size: "sm", onClick: g.rewrapNow, children: t("rewrap") })] })
						: null,
					jx.jsx("div", {
						className: "ig-ctl",
						children: [
							jx.jsx(Sw, { checked: g.enabled, label: t("enable"), onChange: function (v) { g.setEnabled(v); g.dirty(); } }),
							jx.jsx(Sw, { checked: g.dryRun, label: t("dryRun"), onChange: function (v) { g.setDryRun(v); g.dirty(); } }),
							jx.jsx(Num, { label: t("keepRecent"), value: g.keepRecent, onChange: function (v) { g.setKeepRecent(v); g.dirty(); } }),
							jx.jsx(Num, { label: t("maxRetries"), value: g.maxRetries, onChange: function (v) { g.setMaxRetries(v); g.dirty(); } }),
						],
					}),
					jx.jsx(SaveRow, { g: g, t: t }),
					jx.jsx("p", { className: "ig-field-hint", children: t("cfgFile") }),
				],
			});
		}

		/* ---------------- 二级 tab ② 参数 ---------------- */

		function ParamsTab(props) {
			var t = props.t, g = props.g;
			return jx.jsx("div", {
				className: "ig-root",
				children: [
					jx.jsx("div", {
						className: "ig-card",
						children: [
							jx.jsx(Row, {
								children: [
									jx.jsx(Sw, { checked: g.enabled, label: t("enable"), onChange: function (v) { g.setEnabled(v); g.dirty(); } }),
									jx.jsx(Sw, { checked: g.learnLimit, label: t("learn"), onChange: function (v) { g.setLearnLimit(v); g.dirty(); } }),
									jx.jsx(Sw, { checked: g.dryRun, label: t("dryRun"), onChange: function (v) { g.setDryRun(v); g.dirty(); } }),
									jx.jsx(Sw, { checked: g.verbose, label: t("verbose"), onChange: function (v) { g.setVerbose(v); g.dirty(); } }),
								],
							}),
							jx.jsx("hr", { className: "ig-hr" }),
							jx.jsx(Num, { label: t("keepRecent"), value: g.keepRecent, onChange: function (v) { g.setKeepRecent(v); g.dirty(); } }),
							jx.jsx(Num, { label: t("maxRetries"), value: g.maxRetries, onChange: function (v) { g.setMaxRetries(v); g.dirty(); } }),
							jx.jsx(Field, {
								label: t("pathMode"),
								hint: t("pathModeHint"),
								children: jx.jsx("select", {
									className: "ig-in",
									value: g.pathMode,
									onChange: function (e) { g.setPathMode(e.target.value); g.dirty(); },
									children: [
										jx.jsx("option", { value: "basename", children: t("pmBasename") }),
										jx.jsx("option", { value: "relative", children: t("pmRelative") }),
										jx.jsx("option", { value: "full", children: t("pmFull") }),
										jx.jsx("option", { value: "none", children: t("pmNone") }),
									],
								}),
							}),
							jx.jsx(Field, {
								label: t("matchPath"),
								hint: t("matchPathHint"),
								children: jx.jsx("input", { className: "ig-in ig-mono", value: g.matchPath, onChange: function (e) { g.setMatchPath(e.target.value); g.dirty(); } }),
							}),
							jx.jsx(Field, {
								label: t("markerLang"),
								hint: t("markerLangHint"),
								children: jx.jsx("select", { className: "ig-in", value: g.markerLang, onChange: function (e) { g.setMarkerLang(e.target.value); }, children: [
									jx.jsx("option", { value: "", children: t("markerAuto") + " · " + t(g.uiLang === "en" ? "markerEn" : "markerZh") }),
									jx.jsx("option", { value: "zh", children: t("markerZh") }),
									jx.jsx("option", { value: "en", children: t("markerEn") }),
								] }),
							}),
							jx.jsx(Field, {
								label: t("placeholder"),
								hint: t("placeholderHint"),
								children: [
									jx.jsx("textarea", { className: "ig-in ig-mono", rows: 2, value: g.placeholder, placeholder: defaultTemplate(g.effLang), onChange: function (e) { g.setPlaceholder(e.target.value); g.dirty(); } }),
									jx.jsx("div", { className: "ig-preview", children: [jx.jsx("em", { children: t("preview") }), jx.jsx("span", { children: previewMarker(g.placeholder, g.pathMode, g.effLang) })] }),
								],
							}),
						],
					}),
					jx.jsx(SaveRow, { g: g, t: t }),
					jx.jsx(Row, {
						children: [
							jx.jsx(Button, { variant: "outline", size: "sm", onClick: g.reloadNow, children: t("reload") }),
							jx.jsx(Button, { variant: "outline", size: "sm", disabled: g.unreachable, onClick: g.resetNow, children: t("reset") }),
						],
					}),
					jx.jsx("p", { className: "ig-field-hint", children: t("cfgFile") }),
				],
			});
		}

		/* ---------------- 二级 tab ③ 诊断 ---------------- */

		function DiagTab(props) {
			var t = props.t, g = props.g;
			var s = g.status || {};
			var diag = Array.isArray(s.diag) ? s.diag.slice(-12).reverse() : [];
			var kv = function (k, v) {
				return [jx.jsx("dt", { key: k + "-k", children: t(k) }), jx.jsx("dd", { key: k + "-v", children: v })];
			};
			var head = jx.jsx("div", {
				className: "ig-diag-row ig-diag-head",
				children: [jx.jsx("span", { children: "time" }), jx.jsx("span", { children: "input" }), jx.jsx("span", { children: "body" }), jx.jsx("span", { children: "imgs / msgs / bytes" })],
			});
			return jx.jsx("div", {
				className: "ig-root",
				children: [
					jx.jsx("div", {
						className: "ig-card",
						children: [
							jx.jsx("dl", {
								className: "ig-kv",
								children: [].concat(
									kv("health", s.fetchOwned === false ? jx.jsx("b", { children: t("hOwnedNo") }) : s.fetchOwned === true ? jx.jsx("b", { children: t("hOwned") }) : "—"),
									kv("hProbe", (s.probeSeen != null ? s.probeSeen : 0) + " / " + (s.probes != null ? s.probes : 0) + (s.probes && s.probeSeen === 0 ? "（0 = 不在链上）" : "")),
									kv("hPid", String(s.pid != null ? s.pid : "—")),
									kv("hRewrap", String(s.rewraps != null ? s.rewraps : 0) + (s.fetchStolen ? "（已放弃自愈）" : "")),
									kv("uptime", s.startedAt ? fmtUptime(s.startedAt) : "—"),
									kv("cap", g.learned != null ? String(g.learned) : "—"),
									kv("maxSeen", String(s.maxSeen != null ? s.maxSeen : 0)),
									kv("drySkips", String(s.dryRunSkips != null ? s.dryRunSkips : 0)),
									kv("sTok", fmtTokens(s.tokensSaved || 0) + " " + t("sTokUnit")),
								),
							}),
							jx.jsx(Stats, { g: g, t: t }),
							s.fetchOwned === false ? jx.jsx(Row, { children: jx.jsx(Button, { variant: "outline", size: "sm", onClick: g.rewrapNow, children: t("rewrap") }) }) : null,
						],
					}),
					jx.jsx("div", {
						className: "ig-card",
						children: [
							jx.jsx("div", { className: "ig-field-label", children: t("diag") }),
							jx.jsx("div", {
								className: "ig-diag",
								children:
									diag.length === 0
										? jx.jsx("div", { className: "ig-diag-row", children: t("diagEmpty") })
										: [head].concat(
												diag.map(function (d, i) {
													return jx.jsx(
														"div",
														{
															className: "ig-diag-row",
															key: "r" + i,
															children: [
																jx.jsx("b", { children: d.at || "—" }),
																jx.jsx("span", { children: d.input || "?" }),
																jx.jsx("span", { children: d.body || "?" }),
																jx.jsx("span", { children: d.read === false ? t("readFalse") : "imgs=" + (d.imgs != null ? d.imgs : "?") + " msgs=" + (d.msgs != null ? d.msgs : "?") + " bytes=" + (d.bytes != null ? d.bytes : "?") }),
															],
														},
														"d" + i,
													);
												}),
											),
							}),
							jx.jsx("p", { className: "ig-field-hint", children: t("diagHint") }),
						],
					}),
				],
			});
		}

		/* ---------------- 一个一级菜单 + 页内二级 tab ---------------- */

		var TABS = [
			{ id: "overview", label: "tabOverview", comp: OverviewTab },
			{ id: "params", label: "tabParams", comp: ParamsTab },
			{ id: "diag", label: "tabDiag", comp: DiagTab },
		];

		function ImageGuardSection(props) {
			var t = props.t;
			// 界面语言（宿主注入的 ui() 实时读；取不到按中文）：决定「跟随界面语言」时的预览语言
			var uiLang = normLang(typeof props.ui === "function" ? props.ui() : "zh");
			var g = useGuard(uiLang);
			var [tab, setTab] = React.useState("overview");
			var Body = OverviewTab;
			for (var i = 0; i < TABS.length; i++) if (TABS[i].id === tab) Body = TABS[i].comp;
			return jx.jsx("div", {
				className: "ig-root",
				children: [
					jx.jsx("div", { className: "ig-head", children: [jx.jsx("h3", { className: "ig-title", children: t("nav") }), jx.jsx(StatusTag, { g: g, t: t })] }),
					jx.jsx("p", { className: "ig-lede", children: t("lede") }),
					jx.jsx("div", {
						className: "ig-tabs",
						role: "tablist",
						children: TABS.map(function (x) {
							return jx.jsx(Pill, {
								key: x.id,
								active: tab === x.id,
								onClick: function () { setTab(x.id); },
								role: "tab",
								"aria-selected": tab === x.id,
								children: t(x.label),
							});
						}),
					}),
					jx.jsx(Body, { t: t, g: g }),
				],
			});
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
			// 客户端半边绝不能因为自己出错而拖垮设置页
			try {
				if (typeof document !== "undefined") {
					var tagId = "dsh-image-guard/styles.css";
					if (!document.getElementById(tagId)) {
						var st = document.createElement("style");
						st.id = tagId;
						st.setAttribute("data-plugin-css", "");
						st.textContent = css;
						(document.head || document.documentElement).appendChild(st);
					}
				}
				var t = ctx.locale.bind(NS);
				ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-image-guard: section dictionaries");
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register(
						{
							name: "settings.section",
							id: "image-guard",
							order: 41,
							label: function () { return t("nav"); },
							locale: NS,
							inject: function () {
								return {
									t: t,
									// 「跟随界面语言」时，预览必须和真正会生成的语言一致，所以实时读宿主 locale
									ui: function () { try { return ctx.locale.getSnapshot().active || "zh"; } catch (e) { return "zh"; } },
								};
							},
						},
						ImageGuardSection,
					);
				});
			} catch (e) {
				try { console.error("[image-guard] 设置页加载失败：", e); } catch (_) {}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.ImageGuardSection = ImageGuardSection;
		exports.OverviewTab = OverviewTab;
		exports.ParamsTab = ParamsTab;
		exports.DiagTab = DiagTab;
		return module.exports;
	},
});
