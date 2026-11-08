import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  addRankDeltas,
  beijingDate,
  buildPrompt,
  DATA_PATH,
  decodeEnvFile,
  ENV_PATH,
  extractKeywords,
  fetchAiNews,
  fetchGithubTrending,
  fillStarDeltas,
  generateAnalysis,
  isFinanceTitle,
  isLowQualityRepo,
  loadEnvFile,
  normalizeUrl,
  parseStars,
  parseTrendingHtml,
  pickRepos,
  readLlmConfig,
  ReportError,
  safeUrl,
  TRENDING_HTML_URL,
  TRENDING_URL,
  updateData,
} from './update-data.js';

const NOW = new Date('2026-11-06T00:30:00Z');
const SEARCH_URL = 'https://api.github.com/search/repositories';
const HN_URL = 'https://hn.algolia.com/api/v1/search';
const LLM_ENV = { LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://llm.test/v1', LLM_MODEL: 'test-model' };

const dir = mkdtempSync(join(tmpdir(), 'update-data-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 按 URL 前缀路由的 fetch 替身；值为函数时可根据请求动态返回，返回 Response 时原样使用
function mockFetch(routes) {
  // 默认让 GitHub Trending 页面返回空文档（解析不出仓库 → 走 isboyjc / Search 分支）；
  // 需要测 Trending 解析的用例显式传入 [TRENDING_HTML_URL]
  const table = {
    [TRENDING_HTML_URL]: () => new Response('<html><body></body></html>', { status: 200 }),
    ...routes,
  };
  const fn = vi.fn(async (input, init) => {
    const url = String(input);
    const key = Object.keys(table).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const handler = table[key];
    const body = typeof handler === 'function' ? await handler(url, init) : handler;
    return body instanceof Response ? body : Response.json(body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function trendingItem(i, extra = {}) {
  return {
    title: `owner/repo-${i}`,
    url: `https://github.com/owner/repo-${i}`,
    description: `desc ${i}`,
    language: 'TypeScript',
    stars: `${i},000`,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStars', () => {
  it('parses comma-separated strings, numbers and k suffix', () => {
    expect(parseStars('17,010')).toBe(17010);
    expect(parseStars(523)).toBe(523);
    expect(parseStars('1.2k')).toBe(1200);
    expect(parseStars(' 42 ')).toBe(42);
  });

  it('returns 0 for unparseable values', () => {
    expect(parseStars('abc')).toBe(0);
    expect(parseStars(undefined)).toBe(0);
    expect(parseStars(Number.NaN)).toBe(0);
  });
});

describe('safeUrl', () => {
  it('accepts http(s) and rejects other protocols', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(123)).toBeNull();
  });
});

describe('beijingDate', () => {
  it('uses UTC+8 regardless of the machine time zone', () => {
    // UTC 00:00 = 北京 08:00，也就是定时任务的运行时刻
    expect(beijingDate(new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-06');
    expect(beijingDate(new Date('2026-11-05T15:59:59Z'))).toBe('2026-11-05');
    expect(beijingDate(new Date('2026-11-05T16:00:00Z'))).toBe('2026-11-06');
  });
});

describe('fetchGithubTrending', () => {
  it('uses the isboyjc feed when it is fresh, taking the top 5 with numeric stars', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [1, 2, 3, 4, 5, 6].map((i) => trendingItem(i)),
      },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.source).toBe('trending');
    expect(result.dataDate).toBe('2026-11-05');
    expect(result.repos).toHaveLength(5);
    expect(result.repos[0]).toEqual({
      name: 'owner/repo-1',
      description: 'desc 1',
      stars: 1000,
      addStars: 0,
      language: 'TypeScript',
      languageColor: '#3178c6',
      url: 'https://github.com/owner/repo-1',
    });
    // 先请求 Trending 页面（空文档），再请求 isboyjc 榜单
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[0][0])).toContain('github.com/trending');
  });

  it('keeps the feed addStars and a valid languageColor, rejecting unsafe colors', async () => {
    mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [
          trendingItem(1, { addStars: '1,002', language: 'HTML', languageColor: '#e34c26' }),
          trendingItem(2, { language: 'Brainfuck', languageColor: 'red;background:url(x)' }),
        ],
      },
    });

    const [first, second] = (await fetchGithubTrending(NOW, {})).repos;
    expect(first).toMatchObject({ addStars: 1002, languageColor: '#e34c26' });
    // 不在表里的语言、非 hex 颜色都不写入，页面用默认灰色
    expect(second).toMatchObject({ addStars: 0, languageColor: null });
  });

  it('falls back to the GitHub Search API when the feed is older than 48h', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [trendingItem(1)] },
      [SEARCH_URL]: {
        items: [
          { full_name: 'a/b', html_url: 'https://github.com/a/b', description: null, language: null, stargazers_count: 19525 },
        ],
      },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.source).toBe('search');
    expect(result.dataDate).toBe('2026-11-06');
    // Search API 没有今日增量，addStars 为 null，由 fillStarDeltas 对比上一份 data.json 补齐
    expect(result.repos).toEqual([
      { name: 'a/b', description: '', stars: 19525, addStars: null, language: null, languageColor: null, url: 'https://github.com/a/b' },
    ]);
    const searchCall = fetchFn.mock.calls.find(([url]) => String(url).startsWith(SEARCH_URL));
    const searchUrl = new URL(String(searchCall[0]));
    expect(searchUrl.searchParams.get('q')).toBe('created:>=2026-10-30');
    expect(searchUrl.searchParams.get('sort')).toBe('stars');
    // 没有 GITHUB_TOKEN 时匿名请求
    expect(searchCall[1].headers.Authorization).toBeUndefined();
  });

  it('sends GITHUB_TOKEN to the Search API when available', async () => {
    const fetchFn = mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 1 }] },
    });

    await fetchGithubTrending(NOW, { GITHUB_TOKEN: ' ghs_test ' });

    const [, init] = fetchFn.mock.calls.find(([url]) => String(url).startsWith(SEARCH_URL));
    expect(init.headers.Authorization).toBe('Bearer ghs_test');
  });

  it('falls back when the feed request fails', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 1 }] },
    });

    expect((await fetchGithubTrending(NOW, {})).source).toBe('search');
  });

  it('throws a github-stage error when both sources fail', async () => {
    mockFetch({
      [TRENDING_URL]: new Response('boom', { status: 500 }),
      [SEARCH_URL]: new Response('rate limited', { status: 403 }),
    });

    await expect(fetchGithubTrending(NOW, {})).rejects.toMatchObject({ name: 'ReportError', stage: 'github' });
  });

  it('drops items with unsafe urls', async () => {
    mockFetch({
      [TRENDING_URL]: {
        pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT',
        items: [trendingItem(1, { url: 'javascript:alert(1)' }), trendingItem(2)],
      },
    });

    const result = await fetchGithubTrending(NOW, {});
    expect(result.repos.map((r) => r.name)).toEqual(['owner/repo-2']);
  });
});

describe('fetchAiNews', () => {
  it('sorts by points, dedupes titles, links self posts to HN and limits to 5', async () => {
    const fetchFn = mockFetch({
      [HN_URL]: {
        hits: [
          { title: 'Low', url: 'https://www.example.com/low', points: 1, objectID: '1' },
          { title: 'Top story', url: 'https://www.wsj.com/a', points: 469, objectID: '2' },
          { title: 'top story', url: 'https://wsj.com/a-dup', points: 300, objectID: '3' },
          { title: 'Ask HN: agents?', url: null, points: 200, objectID: '4' },
          { title: 'Bad link', url: 'javascript:alert(1)', points: 150, objectID: 'x' },
          { title: 'Four', url: 'https://four.dev', points: 100, objectID: '5' },
          { title: 'Five', url: 'https://five.dev', points: 90, objectID: '6' },
          { title: 'Six', url: 'https://six.dev', points: 80, objectID: '7' },
        ],
      },
    });

    const news = await fetchAiNews(NOW);

    expect(news).toEqual([
      { title: 'Top story', url: 'https://www.wsj.com/a', source: 'wsj.com', points: 469 },
      { title: 'Ask HN: agents?', url: 'https://news.ycombinator.com/item?id=4', source: 'news.ycombinator.com', points: 200 },
      { title: 'Four', url: 'https://four.dev/', source: 'four.dev', points: 100 },
      { title: 'Five', url: 'https://five.dev/', source: 'five.dev', points: 90 },
      { title: 'Six', url: 'https://six.dev/', source: 'six.dev', points: 80 },
    ]);
    // 只查过去 24 小时，关键词之间为 OR
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get('numericFilters')).toBe(`created_at_i>${Math.floor(NOW.getTime() / 1000) - 86400}`);
    expect(url.searchParams.get('optionalWords')).toBe(url.searchParams.get('query'));
  });

  it('throws a news-stage error when nothing matches', async () => {
    mockFetch({ [HN_URL]: { hits: [] } });

    await expect(fetchAiNews(NOW)).rejects.toMatchObject({ stage: 'news' });
  });
});

describe('isFinanceTitle', () => {
  it.each([
    'Nasdaq Sinks 5% as Investors Retreat from AI Trade After Election',
    'Major Investors Are Skeptical Anthropic IPO Can Achieve $1.5T Valuation',
    'AI stock selloffs fuel fears',
    'Wipeout for AI stocks sends Wall Street reeling',
    'AI market cools',
  ])('flags finance headline: %s', (title) => {
    expect(isFinanceTitle(title)).toBe(true);
  });

  it.each([
    'Claude Code sends your email address to websites',
    'Tencent Launches Hy4, One of the Leading Open-Source AI Models',
    'Show HN: An AI agent marketplace',
    'Stockfish-style search for LLM reasoning',
  ])('keeps tech headline: %s', (title) => {
    expect(isFinanceTitle(title)).toBe(false);
  });

  it('drops finance stories from the news list and backfills from the rest', async () => {
    mockFetch({
      [HN_URL]: {
        hits: [
          { title: 'Nasdaq Sinks 5% as Investors Retreat from AI Trade', url: 'https://wsj.com/a', points: 500, objectID: '1' },
          { title: 'Claude Code sends your email address to websites', url: 'https://github.com/x', points: 469, objectID: '2' },
          { title: 'Anthropic IPO valuation doubts', url: 'https://wsj.com/b', points: 300, objectID: '3' },
          { title: 'New open LLM released', url: 'https://example.com/llm', points: 100, objectID: '4' },
        ],
      },
    });

    const news = await fetchAiNews(NOW);

    expect(news.map((n) => n.title)).toEqual(['Claude Code sends your email address to websites', 'New open LLM released']);
  });
});

describe('readLlmConfig', () => {
  it('lists every missing variable', () => {
    expect(() => readLlmConfig({})).toThrow(/LLM_API_KEY、LLM_BASE_URL、LLM_MODEL/);
  });

  it('rejects non-http base urls and trims trailing slashes', () => {
    expect(() => readLlmConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: 'ftp://x', LLM_MODEL: 'm' })).toThrow(ReportError);
    expect(readLlmConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api.moonshot.cn/v1/', LLM_MODEL: 'm' })).toEqual({
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'm',
    });
  });
});

describe('generateAnalysis', () => {
  const config = { apiKey: 'sk-test', baseUrl: 'https://llm.test/v1', model: 'test-model' };

  it('posts an OpenAI-compatible request and returns only the final content', async () => {
    const fetchFn = mockFetch({
      'https://llm.test/v1/chat/completions': {
        choices: [{ message: { role: 'assistant', reasoning_content: '思考中', content: '  今日解读  ' } }],
      },
    });

    expect(await generateAnalysis('prompt text', config)).toBe('今日解读');

    const [, init] = fetchFn.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('test-model');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'prompt text' });
  });

  it('surfaces upstream error details without leaking the key', async () => {
    mockFetch({
      'https://llm.test/v1/chat/completions': new Response('{"error":"invalid api key"}', { status: 401 }),
    });

    const err = await generateAnalysis('p', config).then(
      () => {
        throw new Error('expected generateAnalysis to reject');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ReportError);
    expect(err.stage).toBe('llm');
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('invalid api key');
    expect(err.message).not.toContain('sk-test');
  });

  it('rejects empty content', async () => {
    mockFetch({ 'https://llm.test/v1/chat/completions': { choices: [{ message: { content: '' } }] } });

    await expect(generateAnalysis('p', config)).rejects.toMatchObject({ stage: 'llm' });
  });
});

describe('buildPrompt', () => {
  const repo = { name: 'a/b', description: 'agent tool', stars: 1200, language: 'Rust', languageColor: null, url: 'https://github.com/a/b' };

  it('includes every repo and news item, with star deltas and HN points when known', () => {
    const prompt = buildPrompt(
      [{ ...repo, addStars: 300 }, { ...repo, name: 'c/d', addStars: null }],
      [{ title: 'Claude news', url: 'https://claude.com/x', source: 'claude.com', points: 120 }],
    );
    expect(prompt).toContain('a/b（Rust，1200 stars，今日新增 300）：agent tool');
    expect(prompt).toContain('c/d（Rust，1200 stars）：agent tool');
    expect(prompt).toContain('Claude news（来源：claude.com，HN 120 分）');
    expect(prompt).toContain('300 字');
  });
});

describe('fillStarDeltas', () => {
  const repo = (name, stars, addStars = null) => ({ name, description: '', stars, addStars, language: null, languageColor: null, url: `https://github.com/${name}` });
  const previous = {
    generatedAt: '2026-11-06T00:40:00.000Z',
    githubTrending: [{ name: 'a/b', stars: 1000 }, { name: 'c/d', stars: 50 }],
  };

  it('diffs against the previous data.json and leaves new repos as null', () => {
    const { repos, since } = fillStarDeltas([repo('a/b', 1250), repo('new/one', 900), repo('c/d', 40)], previous);

    expect(repos.map((r) => r.addStars)).toEqual([250, null, 0]);
    expect(since).toBe('2026-11-06T00:40:00.000Z');
  });

  it('keeps deltas that already came from the feed and reports no baseline', () => {
    const { repos, since } = fillStarDeltas([repo('a/b', 1250, 77)], previous);

    expect(repos[0].addStars).toBe(77);
    expect(since).toBeNull();
  });

  it.each([null, 'garbage', { githubTrending: 'nope' }])('tolerates a missing or malformed previous file: %j', (prev) => {
    expect(fillStarDeltas([repo('a/b', 1)], prev)).toEqual({ repos: [repo('a/b', 1)], since: null });
  });
});

describe('extractKeywords', () => {
  it('ranks by number of matching items and matches whole words only', () => {
    const keywords = extractKeywords(
      [{ name: 'x/agent-kit', description: 'Claude Code agents in Rust' }, { name: 'y/storage', description: 'fast object storage' }],
      [
        { title: 'Claude Code sends your email address to websites' },
        { title: 'Agentic coding with open-weight LLMs' },
        { title: 'Facebook runs AI deepfake scam ads' },
      ],
    );

    expect(keywords).toEqual(['Claude', 'Agent', 'LLM', '开源', '安全', 'Rust']);
    // storage 不应命中 RAG
    expect(keywords).not.toContain('RAG');
  });

  it('returns at most 6 keywords and an empty list when nothing matches', () => {
    expect(extractKeywords([], [{ title: 'Claude Anthropic OpenAI DeepSeek agent LLM MCP RAG' }])).toHaveLength(6);
    expect(extractKeywords([], [{ title: 'Nothing relevant here' }])).toEqual([]);
  });
});

describe('updateData', () => {
  // 一套全部成功的上游接口：isboyjc 过期 → 降级 Search，HN 正常，大模型正常
  const happyRoutes = () => ({
    [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [] },
    [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', language: 'Rust', stargazers_count: 7 }] },
    [HN_URL]: { hits: [{ title: 'New open LLM released', url: 'https://example.com/llm', points: 10, objectID: '1' }] },
    'https://llm.test/v1/chat/completions': { choices: [{ message: { content: '第一段\n\n第二段' } }] },
  });

  function tempDataPath() {
    const sub = mkdtempSync(join(dir, 'out-'));
    return join(sub, 'public', 'data.json');
  }

  it('writes the full report to data.json', async () => {
    mockFetch(happyRoutes());
    const path = tempDataPath();

    const report = await updateData({ now: NOW, env: LLM_ENV, path });

    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved).toEqual(report);
    expect(saved).toMatchObject({
      date: '2026-11-06',
      githubTrending: [
        { name: 'a/b', description: '', stars: 7, addStars: null, language: 'Rust', languageColor: '#dea584', url: 'https://github.com/a/b' },
      ],
      aiNews: [{ title: 'New open LLM released', url: 'https://example.com/llm', source: 'example.com', points: 10 }],
      aiAnalysis: '第一段\n\n第二段',
      // 只看名称、描述和标题，不看 language 字段
      keywords: ['LLM'],
      githubSource: 'search',
      githubDataDate: '2026-11-06',
      addStarsSince: null,
    });
    expect(Number.isNaN(Date.parse(saved.generatedAt))).toBe(false);
    // 不留临时文件；同时写出了归档和 feed
    expect(readdirSync(dirname(path)).sort()).toEqual(['data.json', 'feed.xml', 'history', 'sitemap.xml']);
    expect(existsSync(join(dirname(path), 'history', '2026-11-06.json'))).toBe(true);
  });

  it('computes star deltas against the previous data.json', async () => {
    const path = tempDataPath();
    mockFetch(happyRoutes());
    const first = await updateData({ now: NOW, env: LLM_ENV, path });

    const routes = happyRoutes();
    routes[SEARCH_URL].items[0].stargazers_count = 19;
    mockFetch(routes);
    const second = await updateData({ now: new Date(NOW.getTime() + 86400_000), env: LLM_ENV, path });

    expect(second.githubTrending[0].addStars).toBe(12);
    expect(second.addStarsSince).toBe(first.generatedAt);
  });

  it.each([['news', { [HN_URL]: new Response('down', { status: 503 }) }]])(
    'keeps the previous data.json untouched when the %s stage fails',
    async (stage, override) => {
      const path = tempDataPath();
      mockFetch(happyRoutes());
      await updateData({ now: NOW, env: LLM_ENV, path });
      const before = readFileSync(path, 'utf8');

      mockFetch({ ...happyRoutes(), ...override });
      await expect(updateData({ now: NOW, env: LLM_ENV, path })).rejects.toMatchObject({ stage });

      expect(readFileSync(path, 'utf8')).toBe(before);
      // 失败时不会留下 .tmp 半成品
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('still publishes the brief when the LLM fails, marking the analysis unavailable', async () => {
    const path = tempDataPath();
    mockFetch({ ...happyRoutes(), 'https://llm.test/v1/chat/completions': new Response('{"error":"invalid api key"}', { status: 401 }) });

    const report = await updateData({ now: NOW, env: LLM_ENV, path });

    expect(report.aiAnalysis).toBe('');
    expect(report.analysisStatus).toBe('unavailable');
    expect(report.githubTrending).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).analysisStatus).toBe('unavailable');
  });

  it('fails on missing LLM config before making any request and writes nothing', async () => {
    const fetchFn = mockFetch(happyRoutes());
    const path = tempDataPath();

    await expect(updateData({ now: NOW, env: {}, path })).rejects.toMatchObject({ stage: 'config' });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('writes to public/data.json under the project root by default', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(DATA_PATH).toBe(join(projectRoot, 'public', 'data.json'));
  });
});

describe('loadEnvFile', () => {
  const LINES = ['LLM_API_KEY=sk-test', 'LLM_BASE_URL=https://api.deepseek.com', 'LLM_MODEL=deepseek-chat'];
  const EXPECTED = { LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-chat' };
  let n = 0;

  function load(buf, env = {}) {
    const path = join(dir, `${n++}.env`);
    writeFileSync(path, buf);
    const result = loadEnvFile(path, env);
    return { result, env };
  }

  it.each([
    ['LF', Buffer.from(LINES.join('\n'))],
    ['CRLF', Buffer.from(LINES.join('\r\n') + '\r\n')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINES.join('\r\n'))])],
    ['UTF-16 LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LINES.join('\r\n'), 'utf16le')])],
    ['UTF-16 BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(LINES.join('\r\n'), 'utf16le').swap16()])],
  ])('reads every variable from a %s file', (_name, buf) => {
    const { result, env } = load(buf);

    expect(env).toEqual(EXPECTED);
    expect(result.keys).toEqual(Object.keys(EXPECTED));
  });

  it('keeps non-empty existing variables but fills empty ones', () => {
    const { env } = load(Buffer.from(LINES.join('\n')), { LLM_API_KEY: 'from-shell', LLM_MODEL: '' });

    expect(env.LLM_API_KEY).toBe('from-shell');
    expect(env.LLM_MODEL).toBe('deepseek-chat');
  });

  it('reports a missing file without touching env', () => {
    const env = {};
    expect(loadEnvFile(join(dir, 'nope.env'), env)).toEqual({ path: join(dir, 'nope.env'), found: false, keys: [] });
    expect(env).toEqual({});
  });

  it('resolves the default path to the project root, not the cwd', () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(ENV_PATH).toBe(join(projectRoot, '.env'));
  });
});

describe('repo quality filter', () => {
  const repo = (name, description) => ({
    name,
    description,
    stars: 100,
    addStars: 1,
    language: 'Go',
    languageColor: null,
    url: `https://github.com/${name}`,
  });

  it('drops repos without a description or with a description equal to the repo name', () => {
    expect(isLowQualityRepo(repo('a/b', ''))).toBe(true);
    expect(isLowQualityRepo(repo('worldonlyu/Google_AI_Pro_2Year_ZeroCost_Auto', 'Google_AI_Pro_2Year_ZeroCost_Auto'))).toBe(true);
    expect(isLowQualityRepo(repo('a/b', 'A real description'))).toBe(false);
  });

  it('fills up to five and backfills when filtering leaves too few', () => {
    const list = [repo('a/b', 'ok'), repo('c/d', ''), repo('e/f', 'fine')];
    expect(pickRepos(list, 2).map((r) => r.name)).toEqual(['a/b', 'e/f']);
    expect(pickRepos(list, 3).map((r) => r.name)).toEqual(['a/b', 'e/f', 'c/d']);
  });
});

describe('addRankDeltas', () => {
  it('reports rank movement against the previous brief', () => {
    const mk = (name) => ({
      name,
      description: 'd',
      stars: 1,
      addStars: null,
      language: null,
      languageColor: null,
      url: `https://github.com/${name}`,
    });
    const out = addRankDeltas([mk('b/x'), mk('a/y'), mk('c/z')], {
      githubTrending: [mk('a/y'), mk('c/z'), mk('b/x')],
    });
    expect(out.map((r) => r.rankDelta)).toEqual([2, -1, -1]);
  });

  it('leaves new entries as null', () => {
    expect(addRankDeltas([{ name: 'new/one' }], null)[0].rankDelta).toBeNull();
  });
});

describe('decodeEnvFile', () => {
  it('strips a UTF-8 BOM', () => {
    expect(decodeEnvFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A=1')]))).toBe('A=1');
  });
});

// ---------- 新增：GitHub Trending 解析、URL 去重、解读降级 ----------

// 按 GitHub Trending 页面的真实结构裁的一张卡片
const trendingCard = (name, stars, today, language = 'TypeScript', color = '#3178c6', description = 'desc') => `
<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/${name}" data-view-component="true" class="Link">
      <svg class="octicon" viewBox="0 0 16 16"></svg>
      <span data-view-component="true" class="text-normal"> ${name.split('/')[0]} / </span>${name.split('/')[1]}
    </a>
  </h2>
  <p class="col-9 color-fg-muted my-1 pr-4">
      ${description}
  </p>
  <div class="f6 color-fg-muted mt-2">
    <span class="d-inline-block ml-0 mr-3">
      <span class="repo-language-color" style="background-color: ${color}"></span>
      <span itemprop="programmingLanguage">${language}</span>
    </span>
    <a href="/${name}/stargazers" class="Link--muted d-inline-block mr-3">
      <svg class="octicon octicon-star" viewBox="0 0 16 16"></svg>
      ${stars}
    </a>
    <a href="/${name}/forks" class="Link--muted d-inline-block mr-3">
      <svg class="octicon octicon-repo-forked" viewBox="0 0 16 16"></svg>
      1,234
    </a>
    <span class="d-inline-block float-sm-right">
      <svg class="octicon octicon-star" viewBox="0 0 16 16"></svg>
      ${today} stars today
    </span>
  </div>
</article>`;

describe('parseTrendingHtml', () => {
  it('reads name, description, language, total stars and stars today', () => {
    const html = `<div class="Box">${trendingCard('deepseek-ai/dsh-superagent-prototype', '19,710', '1,234', 'TypeScript', '#3178c6', 'Towards an &amp; autonomous agent')}${trendingCard('govijr/terminal-mac', '2,242', '310', 'Swift', '#F05138')}</div>`;

    const repos = parseTrendingHtml(html);

    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      name: 'deepseek-ai/dsh-superagent-prototype',
      description: 'Towards an & autonomous agent',
      stars: 19710,
      addStars: 1234,
      language: 'TypeScript',
      languageColor: '#3178c6',
      url: 'https://github.com/deepseek-ai/dsh-superagent-prototype',
    });
    expect(repos[1]).toMatchObject({ name: 'govijr/terminal-mac', stars: 2242, addStars: 310, languageColor: '#f05138' });
  });

  it('returns an empty list for junk, empty pages and cards without a star count', () => {
    expect(parseTrendingHtml('')).toEqual([]);
    expect(parseTrendingHtml('<html><body>rate limited</body></html>')).toEqual([]);
    expect(parseTrendingHtml(trendingCard('a/b', '', ''))).toEqual([]);
  });
});

describe('normalizeUrl', () => {
  it('strips tracking params, www, trailing slash and anchor', () => {
    expect(normalizeUrl('https://www.example.com/a/?utm_source=x&ref=y#top')).toBe('https://example.com/a');
    expect(normalizeUrl('https://hunch.net/?p=13764006')).toBe('https://hunch.net/?p=13764006');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('rejects non-http(s) values', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe('fetchGithubTrending with the official Trending page', () => {
  it('prefers the Trending page and keeps the real "stars today" delta', async () => {
    mockFetch({
      [TRENDING_HTML_URL]: () => new Response(trendingCard('owner/repo-1', '9,000', '321'), { status: 200 }),
      [TRENDING_URL]: { pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT', items: [trendingItem(1)] },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.source).toBe('trending');
    expect(result.repos[0]).toMatchObject({ name: 'owner/repo-1', stars: 9000, addStars: 321 });
  });

  it('falls through to the feed when the Trending page is empty', async () => {
    mockFetch({
      [TRENDING_HTML_URL]: () => new Response('<html><body></body></html>', { status: 200 }),
      [TRENDING_URL]: { pubDate: 'Thu, 05 Nov 2026 13:56:53 GMT', items: [trendingItem(1)] },
    });

    const result = await fetchGithubTrending(NOW, {});

    expect(result.repos[0].name).toBe('owner/repo-1');
  });
});

describe('fetchAiNews dedupe', () => {
  it('dedupes the same article submitted under different titles and spreads domains', async () => {
    mockFetch({
      [HN_URL]: {
        hits: [
          { title: 'The end of Microsoft Research AI Frontiers', url: 'https://hunch.net/?p=13764006', points: 344, objectID: '1' },
          { title: 'The End of AI Frontiers', url: 'https://hunch.net/?p=13764006', points: 81, objectID: '2' },
          { title: 'Another hunch story', url: 'https://www.hunch.net/?p=999', points: 70, objectID: '3' },
          { title: 'Brave sells its index', url: 'https://searchenginejournal.com/brave/595829/', points: 15, objectID: '4' },
          { title: 'I do not care about AI content', url: 'https://kevinboone.me/ai.html', points: 14, objectID: '5' },
          { title: 'A fifth one', url: 'https://example.org/x', points: 9, objectID: '6' },
        ],
      },
    });

    const news = await fetchAiNews(NOW);

    // 同一 URL 只留一条；hunch.net 先占 1 条，放宽后最多 2 条
    expect(news.map((n) => n.title)).toEqual([
      'The end of Microsoft Research AI Frontiers',
      'Another hunch story',
      'Brave sells its index',
      'I do not care about AI content',
      'A fifth one',
    ]);
  });
});

describe('buildPrompt', () => {
  it('asks the model to avoid repeating yesterday and to cite numbers', () => {
    const prompt = buildPrompt(
      [{ name: 'a/b', description: 'd', stars: 100, addStars: 5, language: 'Go', languageColor: null, url: 'https://github.com/a/b' }],
      [{ title: 'T', url: 'https://e.com', source: 'e.com', points: 7 }],
      '昨天说 Agent 会自己干活',
    );

    expect(prompt).toContain('昨天说 Agent 会自己干活');
    expect(prompt).toContain('至少引用两个具体数字');
    expect(prompt).toContain('a/b');
    expect(prompt).toContain('今日新增 5');
  });
});

describe('archive and feed', () => {
  it('writes a per-day archive, an index page and an RSS feed', async () => {
    const path = join(mkdtempSync(join(dir, 'archive-')), 'public', 'data.json');
    mockFetch({
      [TRENDING_URL]: { pubDate: 'Wed, 26 Aug 2026 13:56:53 GMT', items: [] },
      [SEARCH_URL]: { items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', language: 'Rust', stargazers_count: 7 }] },
      [HN_URL]: { hits: [{ title: 'New open LLM released', url: 'https://example.com/llm', points: 10, objectID: '1' }] },
      'https://llm.test/v1/chat/completions': { choices: [{ message: { content: '今天的解读' } }] },
    });

    await updateData({ now: NOW, env: LLM_ENV, path });

    const publicDir = dirname(path);
    expect(JSON.parse(readFileSync(join(publicDir, 'history', '2026-11-06.json'), 'utf8')).date).toBe('2026-11-06');
    const index = JSON.parse(readFileSync(join(publicDir, 'history', 'index.json'), 'utf8'));
    expect(index[0]).toMatchObject({ date: '2026-11-06', repos: 1, news: 1 });
    expect(readFileSync(join(publicDir, 'history', 'index.html'), 'utf8')).toContain('2026-11-06');
    const feed = readFileSync(join(publicDir, 'feed.xml'), 'utf8');
    expect(feed).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(feed).toContain('<atom:link href=');
    expect(feed).toContain('今天的解读');
    const sitemap = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<lastmod>2026-11-06</lastmod>');
    expect(sitemap).toContain('<loc>https://huanghd1.github.io/zhhe-daily-report/</loc>');
  });
});
