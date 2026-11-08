// 每日简报数据生成脚本：抓 GitHub 榜单和 HN AI 快讯，调用大模型分析，写入 public/data.json。
// 只用 Node 24 原生能力（fetch、node:fs、node:util），没有第三方依赖。
// 本地运行 npm run update（读取根目录 .env）；GitHub Actions 中由 Secrets / Variables 注入环境变量。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * addStars：今日新增 star（isboyjc 自带）；Search API 没有这个数，用上一份 data.json 的 star 数估算，无法估算时为 null
 * @typedef {{ name: string, description: string, stars: number, addStars: number | null, language: string | null, languageColor: string | null, url: string }} TrendingRepo
 * @typedef {{ title: string, url: string, source: string, points: number }} NewsItem
 * @typedef {{ repos: TrendingRepo[], source: 'trending' | 'search', dataDate: string }} GithubResult
 * @typedef {{ apiKey: string, baseUrl: string, model: string }} LlmConfig
 * @typedef {'config' | 'github' | 'news' | 'llm'} ReportStage
 */

// 脚本位于 scripts/，上一级即项目根目录，与启动命令所在目录无关
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ENV_PATH = join(PROJECT_ROOT, '.env');
export const DATA_PATH = join(PROJECT_ROOT, 'public', 'data.json');

// 首选：GitHub 官方 Trending 页面（server-rendered，带 "N stars today"，是唯一能给出真实 24h 增量的来源）
export const TRENDING_HTML_URL = 'https://github.com/trending?since=daily';
// 次选：isboyjc 每日榜单（2026-08 起已停更，只在它还新鲜时使用）
export const TRENDING_URL = 'https://raw.githubusercontent.com/isboyjc/github-trending-api/main/data/daily/all.json';
// 兜底：近 7 天新建、按 star 排序（口径与 Trending 不同，页面会标注）
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
// 归档与 feed 需要站点地址；fork 后改成自己的地址，或用仓库 Variable SITE_URL 覆盖
export const SITE_URL = (process.env.SITE_URL?.trim() || 'https://huanghd1.github.io/zhhe-daily-report').replace(
  /\/+$/,
  '',
);
// 归档保留天数（history/ 下最多留这么多份，feed 取其中最近 20 份）
const ARCHIVE_LIMIT = 60;
const FEED_LIMIT = 20;
// HN 官方 Algolia 搜索接口；hnrss.org 实测不稳定，Anthropic 官网没有 RSS
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_KEYWORDS = 'AI LLM Claude Anthropic';
// 纯财经新闻（股市、IPO、估值等）与“前沿技术动态”无关，标题命中任一词即丢弃。
// 按整词匹配（允许复数），避免误伤 marketplace、Stockfish 这类技术词；不收 shares 等常见动词，免得误删产品新闻
const FINANCE_TITLE_PATTERN =
  /\b(?:stocks?|ipos?|nasdaq|markets?|investors?|valuations?|wall street|sell-?offs?)\b/i;

// GitHub 的语言配色（取自 github-linguist）。isboyjc 自带 languageColor，Search API 没有，按语言名补上
const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Go: '#00ADD8',
  Rust: '#dea584', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Ruby: '#701516', PHP: '#4F5D95',
  Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB', Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c',
  Vue: '#41b883', Svelte: '#ff3e00', 'Jupyter Notebook': '#DA5B0B', Lua: '#000080', Zig: '#ec915c',
  Scala: '#c22d40', Elixir: '#6e4a7e', Haskell: '#5e5086', 'Objective-C': '#438eff', MDX: '#fcb32c',
  Nix: '#7e7eff', Dockerfile: '#384d54', Julia: '#a270ba', R: '#198CE7', Clojure: '#db5855',
  Solidity: '#AA6746', Cuda: '#3A4E3A', Mojo: '#ff4c1f', Astro: '#ff5a03',
};
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// 今日关键词：[展示名, 匹配规则]，统计命中的仓库和快讯条数，按命中数取前 KEYWORD_LIMIT 个。
// 英文按整词匹配，避免 rag 命中 storage 这类误报
const KEYWORD_RULES = [
  ['Claude', /\bclaude\b/i],
  ['Anthropic', /\banthropic\b/i],
  ['OpenAI', /\bopenai\b|\bgpt-?\d/i],
  ['DeepSeek', /\bdeepseek\b/i],
  ['Agent', /\bagent(?:s|ic)?\b|智能体/i],
  ['LLM', /\bllms?\b|大模型|语言模型/i],
  ['模型', /\bmodels?\b|\bweights\b|模型/i],
  ['MCP', /\bmcp\b|model context protocol/i],
  ['RAG', /\brag\b/i],
  ['开源', /\bopen[- ]?(?:source|weights?)\b|开源/i],
  ['推理', /\binference\b|\breasoning\b|推理/i],
  ['GPU', /\bgpus?\b|\bcuda\b|\bnvidia\b|算力/i],
  // 隐私/凭据类新闻的标题往往只写 password、breach，光靠 security/leaks 会漏
  ['安全', /\bsecurity\b|\bprivacy\b|\bleaks?\b|\bscams?\b|\bbreach(?:es)?\b|\bpasswords?\b|\bcredentials?\b|\bvulnerab\w*\b|安全|隐私|泄露/i],
  ['Rust', /\brust\b/i],
];
const KEYWORD_LIMIT = 6;

const FETCH_TIMEOUT_MS = 15_000;
// 推理类模型会先输出思考过程，耗时较长
const LLM_TIMEOUT_MS = 120_000;
// isboyjc 数据超过这个时长视为过期
const TRENDING_MAX_AGE_MS = 48 * 3600_000;
const TOP_REPOS = 5;
// 多取一批候选，过滤掉低质仓库后仍能凑满 5 个
const REPO_CANDIDATES = 12;
// 人工拉黑（小写 full_name）。默认留空；遇到明显刷榜/薅羊毛仓库时加进来即可
export const REPO_DENYLIST = new Set([]);
const TOP_NEWS = 5;
const USER_AGENT = 'zhhe-reonr-daily-report';
// 简报按北京时间归档；中国不实行夏令时，固定 UTC+8，不依赖运行环境的时区设置
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** @param {string} title */
export function isFinanceTitle(title) {
  return FINANCE_TITLE_PATTERN.test(title);
}

// 带阶段信息的错误，失败时打印是哪一步出的问题
export class ReportError extends Error {
  /**
   * @param {ReportStage} stage
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(stage, message, options) {
    super(message, options);
    this.name = 'ReportError';
    /** @type {ReportStage} */
    this.stage = stage;
  }
}

// 北京时间日期（YYYY-MM-DD）。定时任务在北京时间 08:00 运行，简报归档到当天
export function beijingDate(now = new Date()) {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 统一的 fetch + 超时 + 状态码检查，失败时包装为对应阶段的 ReportError
 * @param {ReportStage} stage
 * @param {string} url
 * @param {number} timeoutMs
 * @param {RequestInit} [init]
 * @returns {Promise<unknown>}
 */
async function fetchJson(stage, url, timeoutMs, init = {}) {
  const host = new URL(url).host;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ReportError(stage, `请求失败：${host}（${/** @type {Error} */ (err).message}）`, { cause: err });
  }
  if (!res.ok) {
    // 附带一小段响应体（如大模型返回的 "invalid api key"），方便排查；不会包含请求头里的 key
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ReportError(stage, `请求失败：${host} 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ReportError(stage, `响应不是合法 JSON：${host}`, { cause: err });
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 网络抖动时重试一次；只对「请求直接抛错」重试，HTTP 4xx/5xx 原样返回交给上层判断
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} [attempts]
 */
async function fetchWithRetry(url, init, attempts = 2) {
  /** @type {unknown} */
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(800);
    }
  }
  throw lastError;
}

// "17,010" / 17010 / "1.2k" → 数字；无法解析时返回 0
/** @param {unknown} value */
export function parseStars(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== 'string') return 0;
  const s = value.trim().toLowerCase().replace(/,/g, '');
  const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!match) return 0;
  return Math.round(Number(match[1]) * (match[2] ? 1000 : 1));
}

// 外部链接只接受 http/https，防止 javascript: 等协议进入页面
/** @param {unknown} value */
export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
}

// ---------- HTML / URL 工具 ----------

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** @param {string} value */
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    const key = String(code).toLowerCase();
    if (Object.hasOwn(HTML_ENTITIES, key)) return HTML_ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
    return match;
  });
}

/** @param {string} html */
function htmlToText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'ref_src', 'source', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'spm',
]);

/**
 * 归一化链接用于去重：去掉追踪参数、www、末尾斜杠和锚点。非 http(s) 返回 null。
 * 同一篇文章常被不同标题重复提交（HN 上很常见），所以去重要按 URL 而不是按标题。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  u.hash = '';
  u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * 解析 GitHub Trending 页面的仓库卡片：name / description / language / 总 star / 今日新增 star。
 * 页面改版、被限流或返回空内容时返回 []，由调用方降级到其他来源。
 * @param {string} html
 * @returns {TrendingRepo[]}
 */
export function parseTrendingHtml(html) {
  if (typeof html !== 'string' || !html.includes('Box-row')) return [];
  const chunks = html.split(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>/i).slice(1);
  /** @type {TrendingRepo[]} */
  const repos = [];
  for (const chunk of chunks) {
    const head = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(chunk);
    if (!head) continue;
    const link = /href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/.exec(head[1]);
    if (!link) continue;

    const name = `${link[1]}/${link[2]}`;
    const description = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    const language = /itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\//i.exec(chunk);
    const color = /repo-language-color[^>]*style="[^"]*?(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))(?![0-9a-fA-F])/i.exec(chunk);
    const stargazers = /href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    const today = /([\d,]+)\s+stars?\s+today/i.exec(chunk);

    const stars = parseStars(htmlToText(stargazers ? stargazers[1] : ''));
    if (!stars) continue;

    repos.push({
      name,
      description: description ? htmlToText(description[1]) : '',
      stars,
      addStars: today ? parseStars(today[1]) : null,
      language: language ? htmlToText(language[1]) || null : null,
      languageColor: color ? color[1].toLowerCase() : null,
      url: `https://github.com/${name}`,
    });
  }
  return repos;
}

// ---------- GitHub ----------

// 数据源给出的颜色合法时直接用，否则按语言名查表；页面会把颜色写进 style，所以只接受 #rgb / #rrggbb
/**
 * @param {unknown} explicit
 * @param {string | null} language
 * @returns {string | null}
 */
function languageColorOf(explicit, language) {
  const hex = str(explicit);
  if (HEX_COLOR.test(hex)) return hex;
  return (language && Object.hasOwn(LANGUAGE_COLORS, language) && LANGUAGE_COLORS[language]) || null;
}

/**
 * @param {unknown} raw
 * @param {{ name: string, url: string, stars: string, addStars?: string }} keys
 * @returns {TrendingRepo | null}
 */
function toRepo(raw, keys) {
  const r = asRecord(raw);
  const name = str(r[keys.name]);
  const url = safeUrl(r[keys.url]);
  if (!name || !url) return null;
  const language = str(r.language) || null;
  return {
    name,
    description: str(r.description),
    stars: parseStars(r[keys.stars]),
    addStars: keys.addStars ? parseStars(r[keys.addStars]) : null,
    language,
    languageColor: languageColorOf(r.languageColor, language),
    url,
  };
}

/**
 * GitHub 官方 Trending 页面：server-rendered HTML，卡片里带 "N stars today"。
 * 这是唯一同时给出「今日增量」和「全站热门（含老项目）」的来源；解析不出来时返回 null 交给降级逻辑。
 * @param {Date} now
 * @returns {Promise<GithubResult | null>}
 */
async function fetchTrendingHtml(now) {
  let res;
  try {
    res = await fetchWithRetry(TRENDING_HTML_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ReportError('github', `请求失败：github.com/trending（${/** @type {Error} */ (err).message}）`, { cause: err });
  }
  if (!res.ok) {
    throw new ReportError('github', `GitHub Trending 返回 HTTP ${res.status}`);
  }
  const repos = pickRepos(parseTrendingHtml(await res.text()), TOP_REPOS);
  if (repos.length === 0) return null;
  return { repos, source: 'trending', dataDate: beijingDate(now) };
}

/**
 * 低质仓库：没有描述、描述等于仓库名（刷榜占位），或在人工黑名单里。
 * 只影响展示位的挑选，不改动数据源本身。
 * @param {TrendingRepo} repo
 */
export function isLowQualityRepo(repo) {
  if (REPO_DENYLIST.has(String(repo.name).toLowerCase())) return true;
  const description = String(repo.description ?? '').trim();
  if (!description) return true;
  const slug = String(repo.name).split('/').pop() ?? '';
  const squash = (value) => value.toLowerCase().replace(/[\s_\-.]/g, '');
  return squash(description) === squash(slug);
}

/**
 * 从候选里挑出展示用的仓库：先过滤低质，不足时再用被过滤的补齐（宁可展示也不要空栏）
 * @param {TrendingRepo[]} repos
 * @param {number} [limit]
 * @returns {TrendingRepo[]}
 */
export function pickRepos(repos, limit = TOP_REPOS) {
  const good = repos.filter((repo) => !isLowQualityRepo(repo));
  if (good.length >= limit) return good.slice(0, limit);
  const filler = repos.filter((repo) => isLowQualityRepo(repo)).slice(0, limit - good.length);
  return [...good, ...filler];
}

/**
 * 与上一份简报对比名次：正数 = 上升，负数 = 下降，新上榜为 null
 * @param {TrendingRepo[]} repos
 * @param {unknown} previous 上一份 data.json
 * @returns {(TrendingRepo & { rankDelta: number | null })[]}
 */
export function addRankDeltas(repos, previous) {
  const prev = asRecord(previous);
  /** @type {Map<string, number>} */
  const before = new Map();
  for (const item of Array.isArray(prev.githubTrending) ? prev.githubTrending : []) {
    const r = asRecord(item);
    if (typeof r.name === 'string' && !before.has(r.name)) before.set(r.name, before.size);
  }
  return repos.map((repo, index) => {
    const previousIndex = before.get(repo.name);
    return { ...repo, rankDelta: previousIndex === undefined ? null : previousIndex - index };
  });
}

/**
 * isboyjc 榜单：数据新鲜时返回结果，过期或格式异常时返回 null（交给降级逻辑）
 * @param {Date} now
 * @returns {Promise<GithubResult | null>}
 */
async function fetchTrendingFeed(now) {
  const data = asRecord(await fetchJson('github', TRENDING_URL, FETCH_TIMEOUT_MS));
  const pubDate = new Date(str(data.pubDate));
  if (Number.isNaN(pubDate.getTime()) || now.getTime() - pubDate.getTime() > TRENDING_MAX_AGE_MS) {
    return null;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = pickRepos(
    items
      .map((it) => toRepo(it, { name: 'title', url: 'url', stars: 'stars', addStars: 'addStars' }))
      .filter((r) => r !== null),
    TOP_REPOS,
  );
  if (repos.length === 0) return null;
  return { repos, source: 'trending', dataDate: beijingDate(pubDate) };
}

/**
 * 降级方案：近 7 天新建、按 star 排序的仓库（"近期热门新项目"，与官方 Trending 口径不同）。
 * Actions 的出口 IP 是共享的，匿名请求 Search API 每分钟只有 10 次，容易被限流，所以有 GITHUB_TOKEN 时带上它
 * @param {Date} now
 * @param {string | undefined} token
 * @returns {Promise<GithubResult>}
 */
async function fetchSearchFallback(now, token) {
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `created:>=${since}`,
    sort: 'stars',
    order: 'desc',
    per_page: String(REPO_CANDIDATES),
  });
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = asRecord(await fetchJson('github', `${GITHUB_SEARCH_URL}?${params}`, FETCH_TIMEOUT_MS, { headers }));
  const items = Array.isArray(data.items) ? data.items : [];
  const repos = pickRepos(
    items
      .map((it) => toRepo(it, { name: 'full_name', url: 'html_url', stars: 'stargazers_count' }))
      .filter((r) => r !== null),
    TOP_REPOS,
  );
  if (repos.length === 0) {
    throw new ReportError('github', 'GitHub Search API 未返回任何仓库');
  }
  return { repos, source: 'search', dataDate: beijingDate(now) };
}

/**
 * @param {Date} [now]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<GithubResult>}
 */
export async function fetchGithubTrending(now = new Date(), env = process.env) {
  // 1) 官方 Trending：真实 24h 增量，且老项目也能上榜
  try {
    const trending = await fetchTrendingHtml(now);
    if (trending) return trending;
  } catch {
    // 页面改版 / 被限流 / 网络失败时静默降级
  }
  // 2) isboyjc 每日榜单（2026-08 起已停更，只在其仍然新鲜时使用）
  try {
    const fresh = await fetchTrendingFeed(now);
    if (fresh) return fresh;
  } catch {
    // 同上
  }
  // 3) 兜底：近 7 天新建、按 star 排序
  return fetchSearchFallback(now, env.GITHUB_TOKEN?.trim() || undefined);
}

/**
 * Search API 没有“今日新增 star”：对 addStars 为 null 的仓库，用上一份 data.json 里同名仓库的 star 数算差值。
 * 上一份里没有这个仓库（今天新上榜）时保持 null。返回的 since 是对比基准的生成时间，没有用到时为 null
 * @param {TrendingRepo[]} repos
 * @param {unknown} previous 上一份 data.json 的内容，没有或损坏时为 null
 * @returns {{ repos: TrendingRepo[], since: string | null }}
 */
export function fillStarDeltas(repos, previous) {
  const prev = asRecord(previous);
  /** @type {Map<string, number>} */
  const before = new Map();
  for (const item of Array.isArray(prev.githubTrending) ? prev.githubTrending : []) {
    const r = asRecord(item);
    if (typeof r.name === 'string' && typeof r.stars === 'number') before.set(r.name, r.stars);
  }
  let used = false;
  const filled = repos.map((repo) => {
    const base = before.get(repo.name);
    if (repo.addStars !== null || base === undefined) return repo;
    used = true;
    return { ...repo, addStars: Math.max(0, repo.stars - base) };
  });
  const since = used && !Number.isNaN(Date.parse(str(prev.generatedAt))) ? str(prev.generatedAt) : null;
  return { repos: filled, since };
}

/**
 * 统计仓库（名称 + 描述）和快讯标题里命中的关键词，按命中条数降序，同数时按 KEYWORD_RULES 的顺序
 * @param {TrendingRepo[]} repos
 * @param {NewsItem[]} news
 * @returns {string[]}
 */
export function extractKeywords(repos, news) {
  const texts = [...repos.map((r) => `${r.name} ${r.description}`), ...news.map((n) => n.title)];
  return KEYWORD_RULES.map(([label, pattern], order) => ({
    label,
    order,
    hits: texts.filter((t) => pattern.test(t)).length,
  }))
    .filter((k) => k.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .slice(0, KEYWORD_LIMIT)
    .map((k) => k.label);
}

// ---------- AI 快讯（Hacker News）----------

/** @param {string} url */
function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * 过去 24 小时标题含任一关键词的 HN 帖子，按点赞数取前 TOP_NEWS 条；Ask HN 等无外链的帖子指向 HN 讨论页
 * @param {Date} [now]
 * @returns {Promise<NewsItem[]>}
 */
export async function fetchAiNews(now = new Date()) {
  const since = Math.floor(now.getTime() / 1000) - 86400;
  const params = new URLSearchParams({
    query: HN_KEYWORDS,
    optionalWords: HN_KEYWORDS, // 关键词之间是 OR 关系
    restrictSearchableAttributes: 'title',
    tags: 'story',
    numericFilters: `created_at_i>${since}`,
    hitsPerPage: '50',
    attributesToRetrieve: 'title,url,points,objectID',
  });
  const data = asRecord(await fetchJson('news', `${HN_SEARCH_URL}?${params}`, FETCH_TIMEOUT_MS));

  /** @type {{ title: string, url: string, source: string, points: number, key: string, titleKey: string }[]} */
  const candidates = (Array.isArray(data.hits) ? data.hits : [])
    .map(asRecord)
    .map((hit) => {
      const title = str(hit.title);
      const id = str(hit.objectID);
      const url = safeUrl(hit.url) ?? (/^\d+$/.test(id) ? `https://news.ycombinator.com/item?id=${id}` : null);
      if (!title || !url) return null;
      return {
        title,
        url,
        source: hostOf(url),
        points: parseStars(hit.points),
        // 同一篇文章常被不同标题重复提交，按归一化 URL 去重；标题再兜一层
        key: normalizeUrl(url) ?? url,
        titleKey: title.toLowerCase().replace(/\s+/g, ' ').trim(),
      };
    })
    .filter((item) => item !== null && !isFinanceTitle(item.title))
    .sort((a, b) => b.points - a.points);

  const seenUrl = new Set();
  const seenTitle = new Set();
  /** @type {Map<string, number>} */
  const perHost = new Map();
  const news = [];

  // 先按「同域名最多 1 条」选，凑不满 5 条再放宽到 2 条，避免一个站点/一篇文章占满整栏
  /** @param {number} maxPerHost */
  const take = (maxPerHost) => {
    for (const item of candidates) {
      if (news.length === TOP_NEWS) break;
      if (seenUrl.has(item.key) || seenTitle.has(item.titleKey)) continue;
      const hostCount = perHost.get(item.source) ?? 0;
      if (hostCount >= maxPerHost) continue;
      seenUrl.add(item.key);
      seenTitle.add(item.titleKey);
      perHost.set(item.source, hostCount + 1);
      news.push({ title: item.title, url: item.url, source: item.source, points: item.points });
    }
  };
  take(1);
  take(2);
  // 补位的条目是后追加的，按分数重排一次，页面顺序才是“最热在前”
  news.sort((a, b) => b.points - a.points);

  if (news.length === 0) {
    throw new ReportError('news', 'Hacker News 过去 24 小时没有匹配的 AI 帖子');
  }
  return news;
}

// ---------- 大模型分析（OpenAI 兼容协议）----------

/**
 * 读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，缺失或格式不对时报 config 错误
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {LlmConfig}
 */
export function readLlmConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  const missing = [!apiKey && 'LLM_API_KEY', !baseUrl && 'LLM_BASE_URL', !model && 'LLM_MODEL'].filter(Boolean);
  if (!apiKey || !baseUrl || !model) {
    throw new ReportError(
      'config',
      `未配置 ${missing.join('、')}：本地请写入 .env（参考 .env.example），GitHub Actions 请在仓库 Secrets / Variables 中配置`,
    );
  }
  if (!safeUrl(baseUrl)) {
    throw new ReportError('config', 'LLM_BASE_URL 必须是 http(s) 地址，例如 https://api.deepseek.com');
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/**
 * @param {TrendingRepo[]} repos
 * @param {NewsItem[]} news
 * @param {string} [previousAnalysis] 昨天的解读，用来要求模型换角度、别复读
 */
export function buildPrompt(repos, news, previousAnalysis = '') {
  const repoLines = repos.map(
    (r, i) =>
      `${i + 1}. ${r.name}（${r.language ?? '未知语言'}，${r.stars} stars` +
      `${typeof r.addStars === 'number' ? `，今日新增 ${r.addStars}` : ''}）：${r.description || '无描述'}`,
  );
  const newsLines = news.map(
    (n, i) => `${i + 1}. ${n.title}（来源：${n.source}${n.points ? `，HN ${n.points} 分` : ''}）`,
  );
  const lines = [
    '以下是今天的 GitHub 热门项目和 AI 领域动态：',
    '',
    '【GitHub 热门项目】',
    ...repoLines,
    '',
    '【AI 前沿动态】',
    ...newsLines,
    '',
    '请写一段约 300 字的中文“今日技术趋势与解读”：提炼共同趋势，点评一两个值得关注的项目或事件，',
    '最后给开发者一条实用建议。只输出正文，不要标题、列表或 Markdown 格式。',
  ];
  if (previousAnalysis) {
    lines.push(
      '',
      '【昨天的解读，仅用于避免重复】',
      previousAnalysis.slice(0, 400),
      '',
      '要求：不要重复昨天的论点、开头句式和结尾建议；至少引用两个具体数字（star 总数、今日涨幅或点赞数）；',
      '如果今天的素材确实没有新信号，就换一个更具体的小角度（某个细分领域、某个工程取舍），不要硬凑宏大趋势。',
      '仍然只输出正文。',
    );
  }
  return lines.join('\n');
}

/**
 * @param {string} prompt
 * @param {LlmConfig} config
 * @returns {Promise<string>}
 */
export async function generateAnalysis(prompt, config) {
  const data = asRecord(
    await fetchJson('llm', `${config.baseUrl}/chat/completions`, LLM_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一名资深技术分析师，擅长用简洁的中文解读开源与 AI 趋势。' },
          { role: 'user', content: prompt },
        ],
      }),
    }),
  );
  // 只取最终答案 content；推理模型的 reasoning_content 不写入
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const content = str(asRecord(asRecord(choices[0]).message).content);
  if (!content) {
    throw new ReportError('llm', '大模型返回内容为空');
  }
  return content;
}

// ---------- .env 读取（仅本地运行时使用）----------

// 兼容 Windows 上常见的保存格式：UTF-8 带 BOM、UTF-16 LE/BE（记事本“Unicode”）。
// process.loadEnvFile 遇到 BOM 会丢掉第一行，遇到 UTF-16 会整个文件读不出来
/** @param {Buffer} buf */
export function decodeEnvFile(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 读取 .env 写入 env；已有非空的环境变量优先，不被文件覆盖。文件不存在时（如 GitHub Actions）直接跳过
 * @param {string} [path]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ path: string, found: boolean, keys: string[] }} keys 只含变量名，不含值
 */
export function loadEnvFile(path = ENV_PATH, env = process.env) {
  if (!existsSync(path)) {
    return { path, found: false, keys: [] };
  }
  const parsed = parseEnv(decodeEnvFile(readFileSync(path)));
  for (const [key, value] of Object.entries(parsed)) {
    if (!env[key]) env[key] = value;
  }
  return { path, found: true, keys: Object.keys(parsed) };
}

// ---------- 生成与写入 ----------

/**
 * 抓取并分析，返回写入 data.json 的完整内容；任一步失败都会抛出 ReportError
 * @param {Date} [now]
 * @param {Record<string, string | undefined>} [env]
 * @param {unknown} [previous] 上一份 data.json，用于估算 Search API 数据的 star 增量
 */
export async function buildReport(now = new Date(), env = process.env, previous = null) {
  // 先检查配置，缺 key 时不必发起任何外部请求
  const llm = readLlmConfig(env);
  // 日期在开始时确定，跨零点执行也记在发起当天
  const date = beijingDate(now);
  const [github, news] = await Promise.all([fetchGithubTrending(now, env), fetchAiNews(now)]);
  const { repos: filled, since } = fillStarDeltas(github.repos, previous);
  // 与上一份简报对比名次，页面显示 ▲/▼
  const repos = addRankDeltas(filled, previous);

  // 解读失败不再拖垮整份简报：榜单和快讯照发，页面提示“解读暂缺”，第二天自动恢复
  const prompt = buildPrompt(repos, news, str(asRecord(previous).aiAnalysis));
  let analysis = '';
  let analysisError = null;
  // 模型偶发 5xx / 超时很常见，重试一次再降级
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      analysis = await generateAnalysis(prompt, llm);
      analysisError = null;
      break;
    } catch (err) {
      analysisError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) await sleep(1500);
    }
  }
  if (!analysis) {
    console.warn(`解读生成失败，仅发布榜单与快讯：${analysisError}`);
  }

  return {
    date,
    githubTrending: repos,
    aiNews: news,
    aiAnalysis: analysis,
    analysisStatus: analysis ? 'ok' : 'unavailable',
    keywords: extractKeywords(repos, news),
    githubSource: github.source,
    githubDataDate: github.dataDate,
    // star 增量的对比基准时间（上一份 data.json 的 generatedAt）；增量来自 Trending/isboyjc 或无法估算时为 null
    addStarsSince: since,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 读取上一份 data.json；不存在或损坏时返回 null（只影响 star 增量，不影响生成）
 * @param {string} path
 */
function readPreviousReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 先写临时文件再改名覆盖，写到一半出错也不会留下损坏的 data.json
 * @param {unknown} report
 * @param {string} [path]
 */
export function writeReport(report, path = DATA_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** @param {unknown} value */
function escapeXml(value) {
  return String(value ?? '').replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );
}

/** 读 history/index.json；不存在或损坏时返回空数组 */
function readArchiveIndex(historyDir) {
  try {
    const list = JSON.parse(readFileSync(join(historyDir, 'index.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.date === 'string') : [];
  } catch {
    return [];
  }
}

// 往期列表页：静态生成，不依赖任何接口
function buildArchivePage(entries) {
  const rows = entries
    .map(
      (e) => `      <li>
        <a href="${escapeXml(e.date)}.json"><time>${escapeXml(e.date)}</time></a>
        <span class="meta">${Number(e.repos) || 0} 个仓库 · ${Number(e.news) || 0} 条快讯${
          Array.isArray(e.keywords) && e.keywords.length ? ` · ${escapeXml(e.keywords.join(' / '))}` : ''
        }</span>
        <p>${escapeXml(e.head ?? '')}${e.head ? '…' : ''}</p>
      </li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>往期归档 · 每日前沿科技与 GitHub 趋势</title>
<style>
  body { margin: 0; padding: 40px 20px; background: #06080d; color: #e6edf7;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.sub { color: #93a3b8; font-size: 13px; margin: 0 0 26px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
  li { border: 1px solid rgba(148,163,184,.16); border-radius: 14px; padding: 16px 18px;
    background: rgba(17,24,37,.62); }
  a { color: #6ee7b7; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  time { font-family: Consolas, monospace; font-variant-numeric: tabular-nums; }
  .meta { margin-left: 10px; color: #64748b; font-size: 11px; font-family: Consolas, monospace; }
  li p { margin: 8px 0 0; color: #93a3b8; font-size: 13px; line-height: 1.7; }
</style>
</head>
<body>
  <main>
    <h1>往期归档</h1>
    <p class="sub">每天北京时间 08:00 更新 · <a href="../">返回今日简报</a> · <a href="../feed.xml">RSS</a></p>
    <ul>
${rows || '      <li><p>还没有归档。</p></li>'}
    </ul>
  </main>
</body>
</html>
`;
}

/**
 * RSS 2.0：每条是当天完整解读，阅读器里能直接看，不需要打开网页
 * @param {{ date: string, head?: string }[]} entries
 * @param {string} historyDir
 */
function buildFeed(entries, historyDir) {
  const items = entries.map((e) => {
    let text = e.head ?? '';
    try {
      text = JSON.parse(readFileSync(join(historyDir, `${e.date}.json`), 'utf8')).aiAnalysis || text;
    } catch {
      // 归档缺失时退回摘要
    }
    const pubDate = new Date(`${e.date}T08:00:00+08:00`).toUTCString();
    const categories = (Array.isArray(e.keywords) ? e.keywords : [])
      .map((keyword) => `<category>${escapeXml(keyword)}</category>`)
      .join('');
    return `    <item>
      <title>每日科技简报 ${escapeXml(e.date)}</title>
      <link>${SITE_URL}/</link>
      <guid isPermaLink="false">${SITE_URL}/#${escapeXml(e.date)}</guid>
      <pubDate>${pubDate}</pubDate>
${categories ? `      ${categories}\n` : ''}      <description>${escapeXml(text)}</description>
    </item>`;
  });
  const lastBuildDate = new Date(`${entries[0]?.date ?? beijingDate()}T08:00:00+08:00`).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>每日前沿科技与 GitHub 趋势</title>
    <link>${SITE_URL}/</link>
    <description>每天北京时间 08:00 更新的技术简报</description>
    <language>zh-CN</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
${items.join('\n')}
  </channel>
</rss>
`;
}

/**
 * 站点地图：lastmod 跟着最新一期走，定时任务跑完自动更新
 * @param {{ date: string }[]} entries
 */
function buildSitemap(entries) {
  const lastmod = entries[0]?.date ?? beijingDate();
  const urls = [
    `<url><loc>${SITE_URL}/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${SITE_URL}/history/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`,
    `<url><loc>${SITE_URL}/fortune</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

/**
 * 归档当天简报并重建 history/index.json、history/index.html、feed.xml。
 * 归档失败不影响当天发布（data.json 已经写好了）
 * @param {Awaited<ReturnType<typeof buildReport>>} report
 * @param {string} [publicDir]
 */
export function writeArchive(report, publicDir = dirname(DATA_PATH)) {
  const historyDir = join(publicDir, 'history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${report.date}.json`), `${JSON.stringify(report, null, 2)}\n`);

  const entries = readArchiveIndex(historyDir).filter((entry) => entry.date !== report.date);
  entries.push({
    date: report.date,
    repos: (report.githubTrending ?? []).length,
    news: (report.aiNews ?? []).length,
    keywords: report.keywords ?? [],
    head: (report.aiAnalysis ?? '').slice(0, 90),
  });
  entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const kept = entries.slice(0, ARCHIVE_LIMIT);

  writeFileSync(join(historyDir, 'index.json'), `${JSON.stringify(kept, null, 2)}\n`);
  writeFileSync(join(historyDir, 'index.html'), buildArchivePage(kept));
  writeFileSync(join(publicDir, 'feed.xml'), buildFeed(kept.slice(0, FEED_LIMIT), historyDir));
  writeFileSync(join(publicDir, 'sitemap.xml'), buildSitemap(kept));

  const keptFiles = new Set(kept.map((entry) => `${entry.date}.json`));
  for (const name of readdirSync(historyDir)) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && !keptFiles.has(name)) {
      rmSync(join(historyDir, name), { force: true });
    }
  }
  return kept;
}

/**
 * 全部成功后才写文件；失败时保留上一份 data.json，页面继续显示旧简报
 * @param {{ now?: Date, env?: Record<string, string | undefined>, path?: string }} [options]
 */
export async function updateData({ now = new Date(), env = process.env, path = DATA_PATH } = {}) {
  const report = await buildReport(now, env, readPreviousReport(path));
  writeReport(report, path);
  try {
    writeArchive(report, dirname(path));
  } catch (err) {
    console.warn(`归档 / feed 写入失败（不影响当天简报）：${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

async function main() {
  const envFile = loadEnvFile();
  // 只打印变量名，不打印值；.env 没保存或放错位置时一眼就能看出来
  console.log(
    envFile.found
      ? `已读取 .env：${envFile.keys.length ? envFile.keys.join(', ') : '（没有任何变量）'}`
      : '未找到 .env，仅使用系统环境变量',
  );
  const report = await updateData();
  console.log(
    `已写入 ${relative(PROJECT_ROOT, DATA_PATH)}：${report.date}，` +
      `GitHub ${report.githubSource === 'search' ? '近 7 天新项目' : 'Trending'} ${report.githubTrending.length} 个，` +
      `AI 快讯 ${report.aiNews.length} 条，分析 ${report.aiAnalysis.length} 字，` +
      `关键词 ${report.keywords.join(' / ') || '无'}`,
  );
}

// 直接运行时执行；被测试导入时不执行
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof ReportError ? `生成失败（${err.stage}）：${err.message}` : err);
    process.exitCode = 1;
  });
}
