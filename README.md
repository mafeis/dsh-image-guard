# dsh-image-guard

A DeepSeek Harness (DSH) plugin that keeps image-heavy sessions working. Before a request is sent, historical images are trimmed to a budget; when the provider still rejects the image count with HTTP 400, the plugin learns the cap from that error and retries with fewer images.

[简体中文](README.zh.md) · MIT · v0.8.6

## Highlights

- **Keeps the newest N images, marks the rest** — a trimmed image is replaced by an identifiable marker (file name / path / fingerprint / how to retrieve it), so the model or agent can find it again on demand instead of losing it silently.
- **Learns the provider cap** — parses `At most N image(s) may be provided in one prompt` and retries with N−1 images; once learned, later requests in the same process send N−1 directly.
- **Saves vision tokens** — ≈930 tokens net per trimmed image (972 measured cap − ≈40 marker cost); trimming 14 images to 7 saves ≈6.5k tokens per turn, shown live in the settings page.
- **Never rewrites the conversation** — only the outgoing request body is modified (a `structuredClone` copy), so prefix caching stays intact and disabling the plugin restores the original behaviour.
- **Stays at the head of the fetch chain** — a 1-second watchdog with in-chain probes re-attaches the wrapper, which `dsh-net-proxy` would otherwise bypass while proxying.

## Install

DSH Desktop (recommended: install from the GUI plugin market). Manually, the desktop profile is the one DSH Desktop loads:

```sh
# in <DSH_HOME>/profiles/desktop/package.json
#   dependencies         "dsh-image-guard": "github:mafeis/dsh-image-guard"
#   dsh.profile.bundles  "dsh-image-guard"
cd <DSH_HOME>/profiles/desktop && pnpm install --prefer-offline --ignore-scripts
```

CLI profiles: `dsh plugin --profile <name> add github:mafeis/dsh-image-guard`

Restart DSH Desktop afterwards. Note that `desktop` is reserved for the Electron-held profile, so `dsh plugin --profile desktop …` is refused by the launcher, and adding an `insert` entry to `cordis.patch.yml` by hand does not load a plugin — the GUI reads `dependencies` and `dsh.profile.bundles` only.

## Verify

1. Settings → Image Guard → Diagnostics: the guard should read as attached to the fetch chain, and the in-chain probe counter should increase.
2. `~/.dsh/image-guard-status.json`: `chatPosts` starts growing.
3. To watch before it acts, turn on `dryRun` under Settings — it records what would be trimmed and modifies nothing.

## How it works

```
DSH agent
   │  POST /v1/chat/completions          image_url: data:image/png;base64,…
   ▼
┌─────────────── fetch chain ───────────────┐
│  image-guard       ← trim, learn, retry   │  must sit at this layer
│       ▼                                   │
│  dsh-net-proxy     ← bypasses everything  │
│                      below it when proxying
└───────────────────────────────────────────┘
   ▼
upstream inference service
```

Only `POST` requests that match the chat path and contain images are handled — everything else passes through untouched. The newest `keepRecent` images are kept, the rest become markers, and the request is sent with a `structuredClone`d body. On `At most N image(s)` the cap is parsed, the request is retried with N−1 images, up to `maxRetries` times.

Why a count limit is needed: `--limit-mm-per-prompt.image` counts the **whole prompt**, while the DSH client-side budget counts bytes and pixels with no image-count limit — so a byte budget never prevents this failure, and compacting does not help because it resends the same history. Why the watchdog is needed: while proxying, `dsh-net-proxy` sends through its own sockets and bypasses every fetch wrapper below it, and its follow-the-system-proxy mode reinstalls it at the head of the chain; the 1-second watchdog with in-chain probes keeps this plugin on top, re-attaching at most 5 times.

## What replaces a trimmed image

| Case | Marker |
|---|---|
| Has a path (usual; file name only by default) | `[图片已省略 #1 · 01-race-start.png · 需要时按文件名在工作区内搜索后读取]` |
| `pathMode=full` | `[图片已省略 #1 · C:\path\to\shots\01-race-start.png · 需要时用 read_image 重新读取]` |
| Attachment metadata only | `[图片已省略 #1 · 01-race-start.png · 内联图片 sha256:bf23bcd3 (image/png 1280x720 618 KiB) · 无原文件路径，已无法取回]` |
| Remote URL | `[图片已省略 #1 · race.png · https://…/race.png · 需要时可重新访问该地址]` |

Identity comes from the neighbouring text fragment (`<path>`, file name, dimensions, bytes), then a remote URL, then a **sha1 fingerprint** of the inline data (`first 4 KB + total length`, stable for the same image). When an image cannot be retrieved, the marker says so rather than letting the model guess.

The template (`placeholder`) supports `{index} {name} {path} {url} {id} {mime} {dims} {size} {identity} {hint}`. `{total}` and `{kept}` change as the conversation grows and would invalidate the prefix cache after the trimmed position, so they are not used by default.

Markers are sent to the provider, so the default `pathMode: "basename"` writes only the file name — directory structure and drive letters stay local (`relative` uses paths relative to the workspace or `~`; `none` omits the name too).

## Settings

`~/.dsh/image-guard.json`, applied live without a restart; also editable in the settings page or via the `/_dsh/image-guard` route.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off means fully transparent |
| `keepRecent` | `12` | Newest images kept; older ones become markers (`0` = all) |
| `maxRetries` | `3` | Downgrade retries after a 400 |
| `learnLimit` | `true` | Parse the provider cap from the 400 response |
| `dryRun` | `false` | Observe only, modify nothing |
| `matchPath` | `/chat/completions\|/messages` | Which paths are handled (regex) |
| `placeholder` | `[图片已省略 #{index}{identity}{hint}]` | Marker template |
| `pathMode` | `basename` | `full` / `relative` / `basename` / `none` |
| `tokensPerImage` | `972` | Vision tokens per image used for the savings estimate (`0` = off) |
| `verbose` | `true` | Logging |

## Status

`~/.dsh/image-guard-status.json` holds `chatPosts`, `bundled`, `trimmed`, `imagesDropped`, `retried`, `learnedLimit`, `maxSeen`, `tokensSaved`, plus `fetchOwned` / `probes` / `probeSeen` (a probe count of 0 means the guard is not on the chain) and `diag` (the last 40 request shapes: `input`, `body`, `bytes`, `imgs`, `msgs` — the first place to look when a request is not intercepted). `GET` / `PUT /_dsh/image-guard` read and write the config, `POST ?reset=1` restores defaults, `POST ?rewrap=1` forces re-attachment.

## Limits

| Limit | Detail |
|---|---|
| Image **count only** | No compression or resizing; byte budgets are out of scope |
| One 400 still happens | The cap can only be learned from a 400 response |
| Historical images only | The newest N images are sent as-is, bytes included |
| Watchdog re-attaches at most 5 times | Prevents wrappers nesting; flagged in Diagnostics when exceeded |
| Inline images without a path cannot be recovered | The marker carries a fingerprint and says so |
| Depends on DSH's current request shapes | Unmatched shapes pass through (visible in Diagnostics) |

## License

[MIT](LICENSE) © mafeis
