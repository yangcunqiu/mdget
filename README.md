# mdget

把一个公网文章 URL 转成 Markdown。为「归档 / 喂给 LLM / 离线阅读」设计。

```
mdget "https://mp.weixin.qq.com/s/xxxx"
```

- 正文提取基于 [defuddle](https://github.com/kepano/defuddle)（Obsidian Web Clipper 的引擎）
- 图片自动下载到本地，**按文件头判断真实格式**（很多站点的 `.png` 其实是 WebP/JPEG）
- 视频不转码，保留成可点击链接
- **任何转不出来的媒体都会在 raw markdown 里留下痕迹**，并汇总到文末清单
- 微信「环境异常」验证页会被识别为失败，不会静默产出垃圾文件

## 安装

要求 Node.js >= 20（需要内置 fetch），系统自带 `curl`（Windows 10+ / macOS / Linux 均有）。

本机已通过 `npm link` 链接到全局，直接可用。

**其他机器**：

```bash
git clone <your-repo> && cd mdget
npm install
npm link          # 或 npm install -g .
```

**直接从 Git 仓库装**：

```bash
npm install -g github:<user>/<repo>
# 仓库根目录就是 package.json 所在目录时用：
npm install -g github:<user>/<repo>#subdirectory=tools/mdget
```

**不想全局装**，用 npx 跑一次：

```bash
npx github:<user>/<repo> "https://example.com/post"
```

跨平台说明：
- 代理默认依次尝试 `127.0.0.1:7897`（Clash）、`7890`（Clash 旧版/其他客户端），可用 `--proxy` 或环境变量 `MDGET_PROXY` 覆盖
- 没装代理也不影响：只有直连失败时才会尝试
- 文件名按 Windows 非法字符清理，macOS/Linux 下同样安全

## 用法

```
mdget <url> [选项]
```

### 基本

| 参数 | 说明 |
|---|---|
| `-o, --output <file>` | 直接指定 md 路径（不再建文章文件夹，assets 放 md 同级） |
| `-d, --out-dir <dir>` | 文章文件夹的父目录（默认当前目录） |
| `-a, --assets <dir>` | 图片文件夹名（默认 `assets`） |
| `--flat` | 不建文章文件夹：`<标题>.md` + `assets/` 直接放输出目录 |
| `--no-download` | 不下载图片，保留远程链接 |
| `--no-frontmatter` | 不输出 YAML frontmatter |
| `--no-clean` | 关闭模板垃圾行清理（微信的「在小说阅读器读本章」等） |
| `-q, --quiet` | 只输出最终文件路径 |

### 媒体

| 参数 | 说明 |
|---|---|
| `--video-tag` | 视频保留 `<video>` 标签（默认只留链接；**默认模式保真度更高**，实测 `--video-tag` 会少 3 个） |
| `--keep-small-images` | 保留被判定为小图标的图片 |
| `--report-all` | 清单里连小图标/追踪像素也列出 |

### 网络

| 参数 | 说明 |
|---|---|
| `--proxy <url>` | HTTP 代理，例如 `http://127.0.0.1:7897` |
| `--ua <string>` | 自定义 User-Agent（默认 Chrome UA，微信必需） |
| `--timeout <sec>` | 单次请求超时，默认 30 |
| `--concurrency <n>` | 图片并发，默认 4 |
| `--no-auto-proxy` | 关闭「直连失败后自动试 `127.0.0.1:7897`」（默认开启） |

## 示例

```bash
# 微信文章
mdget "https://mp.weixin.qq.com/s/Cogo7kHZhWwve8vy_raHbQ"

# 需要代理的站点
mdget "https://wxad.design/abc/interactive-design-in-ai" --proxy http://127.0.0.1:7897

# 只留远程图片，只要一个 md 文件
mdget "https://example.com/post" --no-download -o post.md
```

## 输出结构

默认**一篇文章一个同名文件夹**：

```
temp/
  Markdown/
    Markdown.md
    assets/
      img-001.png
```

md 里的图片是相对路径 `![](assets/img-001.png)`，整个 `Markdown/` 可以整体搬走。

### 输出路径规则

| 命令 | 结果 |
|---|---|
| `mdget URL` | `./<标题>/<标题>.md` + `./<标题>/assets/` |
| `mdget URL -d out` | `out/<标题>/<标题>.md` + `out/<标题>/assets/` |
| `mdget URL -o A/a.md` | `A/a.md` + `A/assets/`（不再建文章文件夹） |
| `mdget URL --flat` | `./<标题>.md` + `./assets/` |
| `mdget URL -a img` | `./<标题>/<标题>.md` + `./<标题>/img/` |

- 重复转换同一 URL 会**复用**已有文件夹（不会产生 `-2`）
- 同名但不同 URL 会自建 `<标题>-2/`，不覆盖旧文章

## 媒体留痕规则

| 源元素 | 输出 |
|---|---|
| 普通图 / 懒加载图 | `![alt](xxx.assets/img-001.png)` |
| 视频 | `[🎬 视频（未转码）](https://...mp4)` |
| 音频 | `[🎵 音频（未转码）](https://...mp3)` |
| iframe 嵌入 | `[🖼 嵌入内容（iframe，未解析）](url)` |
| Canvas | `⚠️ Canvas 交互画布（无法导出，请回原页面查看）` |
| CSS 背景图 | `[🖼 背景图（CSS，未解析）](url)` |
| Lottie / JSON 动画 | `[🎞 动画（Lottie/JSON，未解析）](url)` |
| 被抽正文丢弃的图 | 追加到文末「未解析 / 未下载资源」清单 |

文末清单示例：

```markdown
## 未解析 / 未下载资源

> 原文中这些媒体存在，但没能转成 Markdown 内容（已过滤小图标与追踪像素）。链接为原始地址，可回原页面查看。

- 🖼 图片（被判定为非正文/小图标）: https://...
```

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 一般错误（参数、IO） |
| 2 | 被站点拦截（验证页）或正文过短 |
| 3 | 抓取失败（网络 / 代理） |

## 许可

本项目 MIT。依赖许可：defuddle（MIT）、linkedom（ISC），均为宽松许可，可商用、可再分发。

`node_modules` 不要提交，`.gitignore` 已排除。

## 已知限制

- **纯 JS 渲染的页面**抽不到内容（本工具不跑浏览器）。这类站点用 crawl4ai / firecrawl。
- 只有 `<canvas>` 绘制的内容无法静态导出，只能留占位。
- 微信按 UA 判断，默认 UA 已带浏览器标识；连续请求仍可能触发验证页，此时退出码为 2。
- 图片下载失败会保留原 URL 并计入清单，不会中断整个转换。
