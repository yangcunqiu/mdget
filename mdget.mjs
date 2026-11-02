#!/usr/bin/env node
/**
 * mdget — 把一个公网文章 URL 转成 Markdown。
 *
 * 目标：
 *  1. 正文、标题层级、列表、引用、代码块、表格、链接、图片正确
 *  2. 图片下载到本地并按真实格式存盘（很多站点的扩展名是假的）
 *  3. 任何「转换不出来」的媒体（视频/音频/canvas/iframe/背景图/Lottie/被丢弃的图）
 *     都必须在 raw markdown 里留下可读痕迹，绝不静默消失
 *  4. 事后做一次守恒核对，漏掉的追加到文末清单
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

const VERSION = '1.0.0';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HELP = `
mdget v${VERSION}  —  URL -> Markdown（正文 + 图片 + 媒体留痕）

用法:
  mdget <url> [选项]

基本:
  （默认）输出 <标题>/<标题>.md + <标题>/assets/
  -o, --output <file>      直接指定 md 路径：不再建文章文件夹，assets 放 md 同级
  -d, --out-dir <dir>      文章文件夹的父目录（默认当前目录）
  -a, --assets <dir>       图片文件夹名（默认 assets）
      --flat              不建文章文件夹：<标题>.md + assets/ 直接放输出目录
      --no-download       不下载图片，保留远程链接
      --no-frontmatter    不输出 YAML frontmatter
      --no-clean          关闭微信等模板垃圾行清理

媒体行为:
      --video-tag          视频保留 <video> 标签（默认只留可点击链接）
      --keep-small-images  保留被判定为小图标的图片（默认丢弃，但会在清单里报告）
      --report-all         清单里连小图标/追踪像素也一并列出

网络:
      --proxy <url>        HTTP 代理，例如 http://127.0.0.1:7897
      --ua <string>        自定义 User-Agent
      --timeout <sec>      单次请求超时（默认 30）
      --concurrency <n>    图片并发数（默认 4）
      --no-auto-proxy      关闭「直连失败后自动试 127.0.0.1:7897」（默认开启）

其他:
  -q, --quiet              只输出最终结果路径
      --debug              打印诊断信息
  -h, --help               显示帮助
  -v, --version            显示版本

示例:
  mdget "https://mp.weixin.qq.com/s/xxxx"
  mdget "https://wxad.design/abc/xxx" --proxy http://127.0.0.1:7897 -o design.md
  mdget "https://example.com/post" --no-download --out-dir ./notes

退出码: 0 成功 / 1 一般错误 / 2 被站点拦截(验证页) / 3 抓取失败
`;

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    url: null,
    output: null,
    outDir: process.cwd(),
    assets: null,
    download: true,
    frontmatter: true,
    clean: true,
    videoTag: false,
    keepSmallImages: false,
    proxy: process.env.MDGET_PROXY || null,
    ua: DEFAULT_UA,
    timeout: 30,
    concurrency: 4,
    autoProxy: true,
    quiet: false,
    debug: false,
    reportAll: false,
    flat: false,
  };

  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) fail(`参数 ${name} 缺少值`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
      case '-v':
      case '--version':
        console.log(VERSION);
        process.exit(0);
      case '-o':
      case '--output':
        opts.output = need(i, a);
        i++;
        break;
      case '-d':
      case '--out-dir':
        opts.outDir = need(i, a);
        i++;
        break;
      case '-a':
      case '--assets':
        opts.assets = need(i, a);
        i++;
        break;
      case '--no-download':
        opts.download = false;
        break;
      case '--no-frontmatter':
        opts.frontmatter = false;
        break;
      case '--no-clean':
        opts.clean = false;
        break;
      case '--video-tag':
        opts.videoTag = true;
        break;
      case '--keep-small-images':
        opts.keepSmallImages = true;
        break;
      case '--proxy':
        opts.proxy = need(i, a);
        i++;
        break;
      case '--ua':
        opts.ua = need(i, a);
        i++;
        break;
      case '--timeout':
        opts.timeout = Number(need(i, a)) || 30;
        i++;
        break;
      case '--concurrency':
        opts.concurrency = Math.max(1, Number(need(i, a)) || 4);
        i++;
        break;
      case '--auto-proxy':
        opts.autoProxy = true;
        break;
      case '--no-auto-proxy':
        opts.autoProxy = false;
        break;
      case '-q':
      case '--quiet':
        opts.quiet = true;
        break;
      case '--debug':
        opts.debug = true;
        break;
      case '--report-all':
        opts.reportAll = true;
        break;
      case '--flat':
        opts.flat = true;
        break;
      default:
        if (a.startsWith('-')) fail(`未知参数: ${a}（用 --help 查看用法）`);
        else if (!opts.url) opts.url = a;
        else fail(`多余的位置参数: ${a}`);
    }
  }

  if (!opts.url) {
    console.error(HELP);
    fail('缺少 URL');
  }
  if (!/^https?:\/\//i.test(opts.url)) {
    fail(`URL 必须以 http:// 或 https:// 开头: ${opts.url}`);
  }
  return opts;
}

function fail(msg, code = 1) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(code);
}

let OPT = null;
function dbg(...args) {
  if (OPT?.debug) console.error('\x1b[90m[debug]\x1b[0m', ...args);
}
function info(...args) {
  if (!OPT?.quiet) console.error(...args);
}

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

/** 用 curl 拉取，返回 {body:Buffer, finalUrl, contentType, status} */
async function curlFetch(url, { proxy, ua, timeout, binary }) {
  const tmp = path.join(os.tmpdir(), `mdget-${crypto.randomBytes(6).toString('hex')}.bin`);
  const fmt = '\n%{http_code}\n%{content_type}\n%{url_effective}';
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(timeout),
    '-A',
    ua,
    '-H',
    'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    '-o',
    tmp,
    '-w',
    fmt,
  ];
  if (proxy) args.push('-x', proxy);
  args.push(url);

  try {
    const r = await runCurl(args);
    if (r.code !== 0) {
      const hint = /schannel|SSL|TLS/i.test(r.stderr) ? '（可尝试 --proxy）' : '';
      throw new Error(`curl 失败(code=${r.code})${hint}: ${r.stderr.trim().slice(0, 300)}`);
    }
    const lines = r.stdout.trim().split('\n');
    const finalUrl = lines.pop() || url;
    const contentType = (lines.pop() || '').split(';')[0].trim();
    const status = Number(lines.pop() || 0);
    const body = await fsp.readFile(tmp);
    return { body, finalUrl, contentType, status };
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
}

async function nodeFetch(url, { ua, timeout }) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout * 1000),
    headers: {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    body,
    finalUrl: res.url || url,
    contentType: (res.headers.get('content-type') || '').split(';')[0].trim(),
    status: res.status,
  };
}

async function httpGet(url, { proxy, ua, timeout, binary = false }) {
  if (proxy) return curlFetch(url, { proxy, ua, timeout, binary });
  try {
    return await nodeFetch(url, { ua, timeout });
  } catch (e) {
    dbg('node fetch 失败，回退 curl:', e.message);
    return curlFetch(url, { proxy: null, ua, timeout, binary });
  }
}

/** 抓 HTML，处理代理回退与“验证页” */
async function fetchPage(url, opts) {
  const attempts = [];
  if (opts.proxy) attempts.push(opts.proxy);
  attempts.push(null);

  let lastErr = null;
  for (const proxy of attempts) {
    try {
      const r = await httpGet(url, { proxy, ua: opts.ua, timeout: opts.timeout });
      if (r.status === 403 || r.status === 401) {
        lastErr = new Error(`HTTP ${r.status}（站点拒绝访问，可能需要 --proxy 或换 --ua）`);
        continue;
      }
      if (r.status >= 400) {
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      const html = r.body.toString('utf8');
      assertNotBlockedPage(html, r.finalUrl);
      return { html, finalUrl: r.finalUrl };
    } catch (e) {
      lastErr = e;
      dbg(`代理=${proxy ?? '直连'} 失败:`, e.message);
    }
  }

  if (opts.autoProxy && !opts.proxy) {
    for (const proxy of ['http://127.0.0.1:7897', 'http://127.0.0.1:7890']) {
      try {
        info(`  · 直连失败，尝试本地代理 ${proxy} …`);
        const r = await curlFetch(url, { proxy, ua: opts.ua, timeout: opts.timeout });
        const html = r.body.toString('utf8');
        assertNotBlockedPage(html, r.finalUrl);
        opts.proxy = proxy; // 后续图片下载也走这个代理
        return { html, finalUrl: r.finalUrl };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  fail(`抓取失败：${lastErr?.message || 'unknown'}`, 3);
}

/** 微信等站点的“环境异常”验证页是 HTTP 200，必须显式识别 */
function assertNotBlockedPage(html, url) {
  const head = html.slice(0, 4000);
  const blocked =
    /环境异常/.test(head) ||
    /完成验证后即可继续访问/.test(head) ||
    (/微验证|安全验证/.test(head) && head.length < 8000);
  if (blocked) {
    fail(
      `站点返回了「验证/环境异常」页面（HTTP 200，实际不是文章）：${url}\n` +
        `  微信等站点会按 UA 判断。请带浏览器 UA（默认已带），或稍后重试。`,
      2
    );
  }
}

/* ------------------------------------------------------------------ */
/* 抓取前的 DOM 预处理：给表达不了的媒体埋占位符                        */
/* ------------------------------------------------------------------ */

function absUrl(u, base) {
  if (!u) return null;
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

function makeLinkP(doc, text, href) {
  const p = doc.createElement('p');
  if (href) {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.textContent = text;
    p.appendChild(a);
  } else {
    p.textContent = text;
  }
  p.setAttribute('data-mdget', '1');
  return p;
}

function placeBefore(el, node) {
  if (el.parentNode) el.parentNode.insertBefore(node, el);
}

/**
 * 返回 { document, inventory }
 * inventory: [{ type, url, note }]，用于最后守恒核对
 */
function prepareHtml(html, pageUrl, opts) {
  const { document } = parseHTML(html);
  const inventory = [];
  const add = (type, url, note = '') => {
    if (url) inventory.push({ type, url, note });
  };

  // 1) <video>
  for (const el of [...document.querySelectorAll('video')]) {
    const src = absUrl(el.getAttribute('src') || el.querySelector('source')?.getAttribute('src'), pageUrl);
    add('video', src, '视频');
    if (!src) continue;
    const ph = makeLinkP(document, '🎬 视频（未转码）', src);
    if (opts.videoTag) {
      el.setAttribute('controls', '');
      el.parentNode?.insertBefore(ph, el.nextSibling);
    } else {
      el.parentNode?.replaceChild(ph, el);
    }
  }

  // 2) <audio>
  for (const el of [...document.querySelectorAll('audio')]) {
    const src = absUrl(el.getAttribute('src') || el.querySelector('source')?.getAttribute('src'), pageUrl);
    add('audio', src, '音频');
    if (!src) continue;
    el.parentNode?.replaceChild(makeLinkP(document, '🎵 音频（未转码）', src), el);
  }

  // 3) iframe / embed / object —— 否则 defuddle 会把它变成一张“假图片”
  for (const el of [...document.querySelectorAll('iframe, embed, object')]) {
    const src = absUrl(el.getAttribute('src') || el.getAttribute('data'), pageUrl);
    add('iframe', src, '嵌入内容');
    const label =
      el.tagName.toLowerCase() === 'iframe' ? '🖼 嵌入内容（iframe，未解析）' : '📦 嵌入对象（未解析）';
    el.parentNode?.replaceChild(makeLinkP(document, label, src), el);
  }

  // 4) <canvas>
  for (const el of [...document.querySelectorAll('canvas')]) {
    add('canvas', null, 'Canvas 画布');
    el.parentNode?.replaceChild(
      makeLinkP(document, '⚠️ Canvas 交互画布（无法导出，请回原页面查看）', pageUrl),
      el
    );
  }

  // 5) Lottie / JSON 动画容器
  for (const el of [...document.querySelectorAll('[class*="lottie" i], [data-animation-type], [data-lottie]')]) {
    if (!el.isConnected) continue;
    const src = absUrl(
      el.getAttribute('data-src') || el.getAttribute('data-animation-path') || el.getAttribute('src'),
      pageUrl
    );
    add('lottie', src, 'Lottie/JSON 动画');
    el.parentNode?.replaceChild(makeLinkP(document, '🎞 动画（Lottie/JSON，未解析）', src), el);
  }

  // 6) CSS 背景图（同一张背景常被复用到多个装饰层，只留第一个占位）
  const seenBg = new Set();
  for (const el of [...document.querySelectorAll('[style*="background-image"]')]) {
    const style = el.getAttribute('style') || '';
    const m = /background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/i.exec(style);
    if (!m) continue;
    const src = absUrl(m[2], pageUrl);
    if (!src) continue;
    add('bg-image', src, 'CSS 背景图');
    if (!seenBg.has(src)) {
      seenBg.add(src);
      placeBefore(el, makeLinkP(document, '🖼 背景图（CSS，未解析）', src));
    }
    el.setAttribute('style', style.replace(/background(?:-image)?\s*:[^;]*;?/i, ''));
  }

  // 7) 记录所有图片，供守恒核对
  for (const el of [...document.querySelectorAll('img')]) {
    const raw =
      el.getAttribute('src') ||
      el.getAttribute('data-src') ||
      el.getAttribute('data-original') ||
      (el.getAttribute('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0];
    const url = absUrl(raw, pageUrl);
    if (!url) continue;
    const w = parseInt(el.getAttribute('width') || '', 10);
    const h = parseInt(el.getAttribute('height') || '', 10);
    const dimensionalIcon = Number.isFinite(w) && Number.isFinite(h) && Math.min(w, h) <= 48;
    const decorativeUrl = /(1x1|pixel|spacer|blank\.gif|CentralAutoLogin|beacon|tracking)/i.test(url);
    inventory.push({ type: 'image', url, note: '图片', small: dimensionalIcon, decorative: decorativeUrl });
  }

  return { document, inventory };
}

/* ------------------------------------------------------------------ */
/* Markdown 后处理                                                      */
/* ------------------------------------------------------------------ */

const NOISE_EXACT = new Set([
  '在小说阅读器读本章',
  '去阅读',
  '不喜欢',
  '知道了',
  '微信扫一扫',
  '使用小程序',
  '轻点两下取消赞',
  '轻点两下取消在看',
]);

function cleanNoise(md) {
  const lines = md.split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (!t) {
      kept.push(line);
      continue;
    }
    if (NOISE_EXACT.has(t)) continue;
    if (/^微信扫一扫\s*$/.test(t)) continue;
    if (/轻点两下取消/.test(t)) continue;
    if (/^[：，。、；：！？…·\s]+$/.test(t) && t.length <= 40) continue;
    if (/^视频\s*小程序\s*赞/.test(t)) continue;
    // 微信编辑器常见：嵌套 <strong> 产生 ****文本**** 这种坏标记
    kept.push(line.replace(/\*{4,}/g, '**'));
  }
  return kept.join('\n');
}

function collapseBlank(md) {
  return md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim() + '\n';
}

const IMG_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/* ------------------------------------------------------------------ */
/* 图片下载                                                            */
/* ------------------------------------------------------------------ */

function sniffExt(buf, contentType) {
  const b = buf;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP')
    return 'webp';
  if (b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    if (brand.startsWith('avi')) return 'avif';
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'heic';
  }
  if (b.length > 4 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  const head = b.slice(0, 400).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return 'svg';
  if (contentType) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
    };
    if (map[contentType]) return map[contentType];
  }
  return null;
}

async function pool(items, limit, worker) {
  const ret = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return ret;
}

/**
 * 下载 markdown 里的图片，改写为本地相对路径。
 * 返回 { md, downloaded, failed:[{url,reason}] }
 */
async function localizeImages(md, { mdPath, assetsDir, opts }) {
  const urls = [...new Set([...md.matchAll(IMG_RE)].map((m) => m[2]))].filter(
    (u) => /^https?:\/\//i.test(u)
  );
  if (!urls.length) return { md, downloaded: 0, failed: [], localized: new Set() };

  await fsp.mkdir(assetsDir, { recursive: true });

  // 先全部下载到内存，再按 md 中出现的顺序编号写盘，保证文件名稳定可复现
  const failed = [];
  const fetched = await pool(urls, opts.concurrency, async (url) => {
    try {
      const r = await httpGet(url, { proxy: opts.proxy, ua: opts.ua, timeout: opts.timeout, binary: true });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      if (!r.body.length) throw new Error('空响应');
      const ext = sniffExt(r.body, r.contentType);
      if (!ext) throw new Error(`无法识别的图片格式 (${r.contentType || 'no content-type'})`);
      return {
        url,
        body: r.body,
        ext,
        hash: crypto.createHash('sha1').update(r.body).digest('hex'),
      };
    } catch (e) {
      failed.push({ url, reason: e.message });
      dbg(`图片失败 ${url}: ${e.message}`);
      return null;
    }
  });

  const byHash = new Map();
  const map = new Map();
  let counter = 0;
  for (const item of fetched) {
    if (!item) continue;
    if (byHash.has(item.hash)) {
      map.set(item.url, byHash.get(item.hash));
      continue;
    }

    // 找一个可用文件名：已存在且内容相同 -> 复用；内容不同 -> 顺延编号
    let n = counter + 1;
    let target = null;
    while (!target) {
      const name = `img-${String(n).padStart(3, '0')}.${item.ext}`;
      const file = path.join(assetsDir, name);
      let exists = true;
      let same = false;
      try {
        const buf = await fsp.readFile(file);
        same = crypto.createHash('sha1').update(buf).digest('hex') === item.hash;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        exists = false;
      }
      if (!exists) target = { file, name, reuse: false };
      else if (same) target = { file, name, reuse: true };
      else n += 1;
    }

    if (!target.reuse) await fsp.writeFile(target.file, item.body);
    const rel = path.relative(path.dirname(mdPath), target.file).split(path.sep).join('/');
    byHash.set(item.hash, rel);
    map.set(item.url, rel);
    counter = n;
    dbg(`图片 ${item.url} -> ${rel} (${item.ext}, ${item.body.length} bytes, reuse=${target.reuse})`);
  }

  const out = md.replace(IMG_RE, (full, alt, url) => (map.has(url) ? `![${alt}](${map.get(url)})` : full));
  return { md: out, downloaded: map.size, failed, localized: new Set(map.keys()) };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 为文章挑一个目录：同名目录里若已是同一 URL 就复用，否则加 -2 / -3 后缀 */
async function resolveArticleDir(outDir, slug, url) {
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`;
    const dir = path.join(outDir, name);
    const mdFile = path.join(dir, `${name}.md`);
    if (!fs.existsSync(mdFile)) return { dir, name };
    const head = await fsp
      .readFile(mdFile, 'utf8')
      .then((s) => s.slice(0, 3000))
      .catch(() => '');
    if (head.includes(url)) return { dir, name };
  }
  return { dir: path.join(outDir, slug), name: slug };
}

function slugify(s) {
  return (
    (s || 'untitled')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'untitled'
  );
}

function yamlStr(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

async function main() {
  const opts = (OPT = parseArgs(process.argv.slice(2)));
  const t0 = Date.now();

  info(`→ 抓取 ${opts.url}`);
  const { html, finalUrl } = await fetchPage(opts.url, opts);
  info(`  ✓ HTML ${(html.length / 1024).toFixed(0)} KB`);
  dbg(`fetch 完成 +${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const { document, inventory } = prepareHtml(html, finalUrl, opts);
  const placeholders = inventory.filter((i) => i.type !== 'image' && i.type !== 'canvas');
  if (placeholders.length) {
    const byType = placeholders.reduce((a, i) => ((a[i.type] = (a[i.type] || 0) + 1), a), {});
    info(
      `  · 媒体占位: ` +
        Object.entries(byType)
          .map(([k, v]) => `${k}×${v}`)
          .join(' ')
    );
  }

  const result = await Defuddle(document, finalUrl, {
    markdown: true,
    removeSmallImages: !opts.keepSmallImages,
  });
  dbg(`extract 完成 +${((Date.now() - t0) / 1000).toFixed(2)}s`);
  if (!result || !result.content || result.content.length < 80) {
    fail('正文抽取结果为空或过短，可能是反爬/验证页，或页面是纯 JS 渲染', 2);
  }

  let md = result.content;
  if (opts.clean) md = cleanNoise(md);
  md = collapseBlank(md);

  // 输出路径：默认一篇文章一个同名文件夹 <标题>/<标题>.md + <标题>/assets/
  const title = (result.title || '').trim();
  const outDir = path.resolve(opts.outDir);
  await fsp.mkdir(outDir, { recursive: true });

  let mdPath;
  if (opts.output) {
    // 显式指定 md 路径：不再建文章文件夹，assets 放在 md 同级
    mdPath = path.resolve(outDir, opts.output);
  } else if (opts.flat) {
    const base = slugify(title || new URL(finalUrl).hostname);
    mdPath = path.join(outDir, `${base}.md`);
  } else {
    const base = slugify(title || new URL(finalUrl).hostname);
    const picked = await resolveArticleDir(outDir, base, finalUrl);
    mdPath = path.join(picked.dir, `${picked.name}.md`);
  }
  await fsp.mkdir(path.dirname(mdPath), { recursive: true });

  const assetsRelName = opts.assets || 'assets';
  const assetsDir = path.isAbsolute(assetsRelName)
    ? assetsRelName
    : path.join(path.dirname(mdPath), assetsRelName);

  // 图片本地化
  let downloaded = 0;
  let failedImages = [];
  let localized = new Set();
  if (opts.download) {
    const r = await localizeImages(md, { mdPath, assetsDir, opts });
    md = r.md;
    downloaded = r.downloaded;
    failedImages = r.failed;
    localized = r.localized;
    info(`  · 图片: 本地化 ${downloaded} 张${failedImages.length ? `，失败 ${failedImages.length} 张` : ''}`);
    info(`  · 图片目录: ${assetsDir}`);
  } else {
    info('  · 图片: 保留远程链接（--no-download）');
  }

  // 守恒核对：源页面里的媒体，有多少没出现在 md 里
  const mdUrls = new Set([...md.matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]));
  const missing = inventory.filter(
    (i) => i.url && !localized.has(i.url) && ![...mdUrls].some((u) => u === i.url || u.startsWith(i.url))
  );
  const canvasCount = inventory.filter((i) => i.type === 'canvas').length;

  const unresolved = [];
  const seenUnresolved = new Set();
  let filteredDecor = 0;
  for (const m of missing) {
    if (m.type === 'image' && (m.small || m.decorative) && !opts.reportAll) {
      filteredDecor += 1;
      continue;
    }
    const key = `${m.type}|${m.url}`;
    if (seenUnresolved.has(key)) continue;
    seenUnresolved.add(key);
    unresolved.push({ kind: m.type, url: m.url, note: m.note });
  }
  if (filteredDecor) dbg(`忽略 ${filteredDecor} 个小图标/追踪像素`);
  for (const f of failedImages) {
    const key = `image-download|${f.url}`;
    if (seenUnresolved.has(key)) continue;
    seenUnresolved.add(key);
    unresolved.push({ kind: 'image-download', url: f.url, note: f.reason });
  }

  if (unresolved.length || canvasCount) {
    md += '\n## 未解析 / 未下载资源\n\n';
    md += '> 原文中这些媒体存在，但没能转成 Markdown 内容（已过滤小图标与追踪像素）。链接为原始地址，可回原页面查看。\n\n';
    const icon = {
      video: '🎬 视频',
      audio: '🎵 音频',
      iframe: '🖼 嵌入内容',
      'bg-image': '🖼 背景图',
      lottie: '🎞 动画',
      image: '🖼 图片（被判定为非正文/小图标）',
      'image-download': '🖼 图片（下载失败）',
    };
    for (const u of unresolved) {
      md += `- ${icon[u.kind] || u.kind}: ${u.url}${u.note && u.kind === 'image-download' ? ` （${u.note}）` : ''}\n`;
    }
    if (canvasCount) md += `- ⚠️ Canvas 画布 ${canvasCount} 处（无法导出，需回原页面）\n`;
    md += '\n';
  }

  // frontmatter
  const head = [];
  if (opts.frontmatter) {
    head.push('---');
    if (title) head.push(`title: ${yamlStr(title)}`);
    if (result.author) head.push(`author: ${yamlStr(result.author)}`);
    if (result.site) head.push(`site: ${yamlStr(result.site)}`);
    if (result.published) head.push(`published: ${yamlStr(result.published)}`);
    if (result.description) head.push(`description: ${yamlStr(result.description)}`);
    head.push(`source: ${yamlStr(finalUrl)}`);
    head.push(`converted: ${yamlStr(new Date().toISOString())}`);
    if (downloaded) head.push(`images_local: ${downloaded}`);
    if (unresolved.length) head.push(`unresolved_media: ${unresolved.length}`);
    head.push('---', '', '');
  }

  md = head.join('\n') + md;
  md = collapseBlank(md);

  await fsp.writeFile(mdPath, md, 'utf8');

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  info(
    `  ✓ 完成 ${secs}s · ${md.length} 字符 · 图片 ${downloaded} 张 · 未解析 ${unresolved.length} 项${
      canvasCount ? ` · canvas ${canvasCount}` : ''
    }`
  );
  console.log(mdPath);
}

main().catch((e) => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND') {
    fail('缺少依赖，请先在工具目录执行 npm install');
  }
  fail(e?.stack && OPT?.debug ? e.stack : e?.message || String(e));
});
