# Contributing

欢迎提 issue 和 PR。这个项目刻意保持「零运行时依赖」，改之前先看一眼这几条。

## 本地跑起来

```bash
npm install        # 只装 vitest
cp .env.example .env   # 填 LLM_API_KEY 等
npm run update     # 生成 public/data.json（会真实调用一次大模型，花钱）
npm run preview    # http://127.0.0.1:4173/
npm test           # 单元测试，mock fetch，不联网、不花钱
```

## 提交前

- `npm test` 必须全绿；改数据字段时同步改 `public/index.html` 和测试里的断言。
- 不要引入新的运行时依赖（抓取 / 解析 / feed 都用 Node 原生能力）。只允许开发依赖，且需要说明理由。
- 不要提交 `.env`、任何 API key、`public/` 里不该公开的文件。
- 抓取失败要继续走降级链（Trending → isboyjc → Search），不要让页面白屏。

## 常见改动在哪

| 想改什么 | 改哪里 |
| --- | --- |
| GitHub 榜单口径 | `fetchGithubTrending` / `parseTrendingHtml` |
| 屏蔽刷榜仓库 | `REPO_DENYLIST` 或 `isLowQualityRepo` |
| 快讯关键词、去重、域名上限 | `fetchAiNews`、`HN_KEYWORDS`、`normalizeUrl` |
| 页面文案与样式 | `public/index.html` |
| 解读提示词 | `buildPrompt` |
| 归档 / RSS / sitemap | `writeArchive`、`buildFeed`、`buildSitemap` |

## 提交信息

用一句话说清改了什么，例如 `feat: 用官方 Trending 页面替代停更的榜单源`、`fix: 同一篇文章被收录两次`。

## 数据口径

- `githubSource: "trending"`：官方 Trending 页面，`addStars` 是真实的「stars today」。
- `githubSource: "search"`：降级到 Search API（近 7 天新建、按 star 排序），`addStars` 是与上一份 `data.json` 的差值，新上榜为 `null`。
- `analysisStatus: "unavailable"`：当天大模型失败，榜单与快讯照发，页面会标注。
