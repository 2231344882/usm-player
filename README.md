# USM 播放器 · 网页版（可部署到 GitHub Pages）

纯静态：一个 `index.html` + 一个 120 KB 的 WASM 解码器，没有后端。

```
site/
├── index.html
├── css/app.css
├── js/
│   ├── app.js          # 目录、UI、本地文件、导出
│   ├── live.js         # 播放引擎（MSE 画面 + WebAudio 声音）
│   ├── usm-worker.js   # WASM 解码 worker
│   └── vendor/         # usm_decoder.js + usm_decoder_bg.wasm（原站同款解码器）
└── data/catalog.json   # 354 部片源：剧情名 / 版本 / 大小 / 直链 / 密钥
```

## 部署到 GitHub Pages

```bash
# 在 UsmPlayer/ 下
python build_site.py            # 重新生成 site/（目录 + 资源）
cd site
git init && git add . && git commit -m "usm player"
git remote add origin git@github.com:<你>/usm-player.git
git push -u origin main
```

仓库 **Settings → Pages → Build and deployment** 选 `Deploy from a branch`，分支 `main`、目录 `/ (root)`，
一分钟后访问 `https://<你>.github.io/usm-player/`。

> 也可以把 `site/` 改名为 `docs/`，Pages 目录选 `/docs`，这样源码和数据在同一个仓库里更整齐。
> 仓库自带 `.nojekyll`，不用担心下划线目录被忽略。

## 关键限制：必须配一个代理

官方 CDN `autopatchcn.yuanshen.com` **不返回 CORS 头**，浏览器里的 JS 读不到字节。
所以静态站的「在线播放」需要一个支持 `Range` 的小代理。三种都行：

| 方案 | 做法 | 地址格式 | 国内可用 |
| --- | --- | --- | --- |
| **Cloudflare Pages 直接上传**（推荐） | 面板 Create → Pages → **Upload assets** → 拖入 `worker/pages-upload.zip` → Deploy | `https://xxx.pages.dev/?url=` | ✅ 可解析 |
| **Deno Deploy Playground** | console.deno.com → 建 organization → Applications → New Playground → 覆盖 main.ts → Deploy | `https://<slug>.deno.net/?url=` | ✅ 可解析（`*.deno.net` → 69.67.170.170） |
| **Val Town** | val.town 新建 HTTP val，粘贴 `worker/valtown.ts` | `https://<user>-<val>.web.val.run/?url=` | ✅ 可解析 |
| Cloudflare Pages + Git | 仓库含 `functions/proxy.js`，Connect to Git | `https://xxx.pages.dev/proxy?url=` | ✅ 可解析 |
| Deno Deploy（CLI + token） | token 在 console.deno.com → Organization Settings → Access Tokens | `https://<slug>.deno.net/?url=` | ✅ |
| **Cloudflare Worker** | 粘贴 `worker/cloudflare-worker.js` | `https://xxx.workers.dev/?url=` | ❌ **国内 DNS 污染** |
| **本地版当代理** | 本机跑 `app.py`（`启动播放器.bat`） | `http://127.0.0.1:8770/api/proxy?u=` | ✅ 仅本机 |

> 有域名的话，给 Cloudflare Worker 绑一个自有域名（Custom Domain）也能绕开 workers.dev 的污染，最稳。

实测（本机 DNS + TLS）：

```
*.workers.dev   → 解析到 204.79.197.217，连接失败（污染）
*.vercel.app    → 解析到 108.160.166.49，连接失败（污染）
*.pages.dev      → 172.66.47.32    HTTPS 正常
*.deno.dev       → 34.120.54.55    HTTPS 正常
*.netlify.app    → 13.215.239.219  HTTPS 正常

### 已经部署好的一个（默认）

```
https://usm-proxy.xyh223.deno.net/?url=
```

页面默认就用它，不用配也能直接播。想换成自己的，在「代理设置」里覆盖即可；
点「测试」应返回 206 + 32 字节。

## 三种用法

1. **在线播放**：左侧点条目 → 边下边解密边播放（需要代理）。目前覆盖 189 部有官方直链的片源。
2. **本地文件**：把 `.usm` 拖进窗口 → 完全离线播放，密钥自动从目录里按文件名匹配；目录里没有的会弹框让你填 16 位密钥。
3. **导出 MKV**：点「导出 MKV」→ 浏览器里的 WASM 直接把 USM 封装成 MKV 下载（音轨是 PCM，无损；不需要 ffmpeg）。

## 做不到的部分（和本地版的差别）

- **分块包版本（145 部，5.6 以后）**：官方只发 Sophon 分块，需要服务端做 zstd 解压 + 拼装。
  静态站没有这个能力，点开会提示用本地版。本地版已经支持。
- 无直链的 20 部（官方已下架）两边都播不了。
- 首次播放前浏览器要下载 3 个文件（约 200 KB），之后有 HTTP 缓存。

## 本地调试

```bash
cd site
python -m http.server 8781
# 打开 http://127.0.0.1:8781/
```

`python -m http.server` 不支持 Range，但播放器能兼容（会退化成整段下载）。

## 大文件

播放器默认把请求切成 **16MB 一段**（`window.USM_SEG` 可改），这样即使代理单次响应有上限
（Cloudflare Workers/Pages 是 100MB）也能播 300MB 的片子，弱网下还能自动续拉。
