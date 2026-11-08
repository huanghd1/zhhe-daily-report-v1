# 项目说明

纯静态的每日简报站点，部署在 GitHub Pages，没有后端和数据库。GitHub Actions 每天运行 `scripts/update-data.js` 生成 `public/data.json`，提交回仓库后把 `public/` 发布到 Pages。

## 项目结构

```
.
├── public/                  # 发布到 Pages 的全部内容，不要放任何不该公开的文件
│   ├── index.html           # 每日简报页面（/），纯 HTML/CSS/JS，fetch('./data.json')
│   ├── fortune.html         # 赛博求签（/fortune），签文写死在页面里
│   └── data.json            # 生成产物，需提交到版本库（Actions 每天自动提交）
├── scripts/
│   ├── update-data.js       # 抓 GitHub 榜单、HN AI 快讯，调用大模型分析，原子写入 data.json；纯 JS（ESM），无第三方依赖
│   ├── update-data.test.js  # vitest，mock fetch、写临时目录，不发外网请求、不碰真实 data.json
│   └── preview.js           # 本地预览，node:http 只监听 127.0.0.1，只提供 public/ 下的文件
├── .github/workflows/update.yml  # 定时生成 + 提交 + 发布 Pages
├── .env                     # 本地环境变量，不进版本库
├── .env.example             # 环境变量模板（可提交）
└── package.json             # 只有 vitest 一个开发依赖
```

## 命令

```bash
npm install                 # 只装 vitest
npm test -- --reporter=dot  # 运行全部测试
npm run update              # 本地生成 public/data.json（读取 .env，会真实调用大模型）
npm run preview             # http://127.0.0.1:4173/ 预览，PORT 可改端口
```

## 环境变量

| 变量 | 本地 | Actions | 说明 |
| --- | --- | --- | --- |
| `LLM_API_KEY` | `.env` | Secret（必填） | 大模型 API key |
| `LLM_BASE_URL` | `.env` | Variable，默认 `https://api.deepseek.com/v1` | 请求 `${LLM_BASE_URL}/chat/completions` |
| `LLM_MODEL` | `.env` | Variable，默认 `deepseek-chat` | 如 `deepseek-chat`、`kimi-k3.1-pro` |
| `GITHUB_TOKEN` | 可选 | 自动注入 `github.token` | 降级到 GitHub Search API 时带上，避免匿名限流 |

`.env` 由脚本自行解析（兼容 UTF-8 BOM / UTF-16），已存在且非空的环境变量优先。三个 `LLM_*` 任一缺失时脚本在发请求前就报 config 错误并以非 0 退出。

## 生成逻辑

- 数据源：GitHub 榜单优先抓 `https://github.com/trending?since=daily` 官方页面（`parseTrendingHtml` 正则解析，带 `N stars today` 真实增量）；解析失败/改版时退回 isboyjc 榜单（`pubDate` 超过 48 小时即视为过期，2026-08 起已停更）；最后兜底 GitHub Search API（近 7 天新建、按 star 排序）。`githubSource` 记录实际来源（`trending` / `search`）。AI 快讯用 HN Algolia 接口（标题含 AI / LLM / Claude / Anthropic、过去 24 小时、按点赞数排序），按 `normalizeUrl` 归一化 URL 去重、同域名最多 1 条（不够 5 条放宽到 2 条），`isFinanceTitle` 过滤财经标题。Anthropic 官网没有 RSS，hnrss.org 不稳定。
- 抓取任一步失败都抛出带 `stage`（config / github / news / llm）的 `ReportError`，脚本以非 0 退出，不写文件。**例外**：解读（llm 阶段）失败不再阻断发布——榜单与快讯照写，`analysisStatus: 'unavailable'`，页面显示「解读生成失败」。写入时先写 `data.json.tmp` 再改名，旧文件要么完整保留要么被完整替换。
- 日期固定按北京时间（UTC+8）计算，不依赖运行环境时区；页面同样按北京时间判断“今天”，数据不是今天时显示提示条。
- `data.json` 字段：`date`、`githubTrending`、`aiNews`、`aiAnalysis`、`analysisStatus`（`ok` / `unavailable`）、`keywords`、`githubSource`、`githubDataDate`、`addStarsSince`、`generatedAt`（ISO 字符串）。改字段时 `index.html` 和测试要一起改。写盘后还会更新 `public/history/`（按天归档 + `index.json` + 列表页）和 `public/feed.xml`（最近 20 期 RSS），归档失败不影响当天 `data.json`。
  - 仓库：`name`、`description`、`stars`、`addStars`、`language`、`languageColor`、`url`。`addStars` 在 Trending 模式下是官方「N stars today」，在 isboyjc 模式下是自带值；Search API 没有这个数，用上一份 data.json 同名仓库的 star 数算差值（`fillStarDeltas`），新上榜仓库为 `null`；`addStarsSince` 是对比基准的 `generatedAt`。`languageColor` 只接受 `#rgb` / `#rrggbb`，页面写进 style 前会再校验一次。
  - 快讯：`title`、`url`、`source`、`points`（HN 点赞数）。
  - `keywords`：`extractKeywords` 按 `KEYWORD_RULES` 整词匹配仓库名称 + 描述和快讯标题，按命中条数取前 6 个。
- 页面没有生成接口，右上角“手动更新数据”只是跳转到 Actions 的 workflow 页面手动触发。

## GitHub Actions

- 触发：`cron: '0 0 * * *'`（UTC 0 点 = 北京 08:00）、手动 `workflow_dispatch`、推送到 main 且改动 `public/`、`scripts/` 或 workflow 本身。
- 定时 / 手动：生成 → 有变化才以 github-actions[bot] 提交 `public/data.json` → 发布。推送触发：跳过生成，只重新发布。
- 用 `GITHUB_TOKEN` 推送的提交不会再次触发 workflow。Pages 来源需设为 GitHub Actions（不是从分支部署）。
- 权限按 job 最小化：build 只有 `contents: write`，deploy 只有 `pages: write` + `id-token: write`。

## 安全

- 页面所有外部数据都通过 `textContent` 写入，链接只接受 http/https（脚本 `safeUrl` 和页面 `safeHref` 两层校验）。
- 错误信息只包含主机名、状态码和最多 200 字的响应体，不含请求头里的 key；不要在日志里打印 `.env` 的值。
- `public/` 会原样公开，不要把密钥、`.env` 或数据库文件放进去。

## 依赖与环境

- 开发依赖：vitest 5.1.0（精确锁定）。抓取、定时、大模型调用全部用 Node 原生能力，不引入 rss-parser、node-cron、模型 SDK。
- 运行环境：Node 24.22.1，npm 11.19.1（Windows 11）；Actions 使用 Node 24。
- 安装依赖时 npm 偶尔因堆内存断言崩溃（退出码 134），重试即可。
