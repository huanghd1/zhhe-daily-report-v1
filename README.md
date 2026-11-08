# zhhe-reonr · 每日前沿科技与 GitHub 趋势简报

[![部署](https://github.com/huanghd1/zhhe-daily-report/actions/workflows/update.yml/badge.svg)](https://github.com/huanghd1/zhhe-daily-report/actions/workflows/update.yml)
[![测试](https://github.com/huanghd1/zhhe-daily-report/actions/workflows/test.yml/badge.svg)](https://github.com/huanghd1/zhhe-daily-report/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

纯静态站点，部署在 GitHub Pages。GitHub Actions 每天北京时间 08:00 运行 `scripts/update-data.js`：抓取 GitHub 热门项目和 Hacker News 上的 AI 快讯，调用大模型生成中文解读，写入 `public/data.json` 并提交回仓库，然后把 `public/` 发布到 Pages。页面只读取这个 JSON，没有后端和数据库。

- `/`：每日简报（GitHub 趋势 TOP 5 + AI 快讯 + 关键词 + 大模型解读）
- `/history/`：往期归档，`/feed.xml`：RSS
- `/fortune`：赛博求签（签文写在页面里，纯前端随机抽取）

数据不是当天时，页面顶部会出现一条提示；榜单会标注实际口径（官方 Trending / 近 7 天新项目）。

## 目录结构

```
.
├── public/                 # 发布到 Pages 的全部内容
│   ├── index.html          # 每日简报页面，fetch('./data.json')
│   ├── fortune.html        # 赛博求签
│   ├── data.json           # 由脚本生成，Actions 每天自动提交
│   ├── feed.xml            # 最近 20 期的 RSS
│   ├── history/            # 往期归档：<日期>.json + index.json + index.html
│   ├── robots.txt
│   └── sitemap.xml
├── scripts/
│   ├── update-data.js      # 抓取 + 大模型分析 → data.json / 归档 / feed（无第三方依赖）
│   ├── update-data.test.js # vitest 测试，mock fetch，不发外网请求
│   └── preview.js          # 本地预览服务，只监听 127.0.0.1
└── .github/workflows/update.yml
```

## Fork 一份给自己用

1. Fork 本仓库，Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
2. Settings → Secrets and variables → Actions：新建 Secret `LLM_API_KEY`；可选 Variable `LLM_BASE_URL`、`LLM_MODEL`、`SITE_URL`。
3. 把 `public/index.html` 里的 canonical / og:url / JSON-LD 地址、`public/robots.txt` 和 `public/sitemap.xml` 里的域名换成你的；再设 Variable `SITE_URL`（例如 `https://<用户名>.github.io/<仓库名>`），feed 和 sitemap 就会用新地址。
4. Actions → 每日简报 → Run workflow，跑一次。

## 部署到 GitHub Pages

1. 仓库需为公开仓库（免费账号的私有仓库不能使用 Pages）。
2. Settings → Secrets and variables → Actions → Secrets → New repository secret：名称 `LLM_API_KEY`，值为大模型 API key。
3. 同一页面切到 Variables（可选）：`LLM_BASE_URL`、`LLM_MODEL`。不设置时默认 `https://api.deepseek.com/v1` 和 `deepseek-chat`。
4. Settings → Pages → Build and deployment → Source 选 GitHub Actions。
5. Actions → 每日简报 → Run workflow，手动跑一次。成功后访问 `https://<用户名>.github.io/<仓库名>/`。

之后每天北京时间 08:00 自动更新（GitHub 定时任务高峰期可能延迟十几分钟到半小时）。某天生成失败时，页面继续显示上一份简报并提示未更新，Actions 会发邮件通知。只修改 `public/` 或 `scripts/` 并推送时，workflow 只重新发布，不调用大模型。

## 本地运行

需要 Node.js 24 或以上。

```bash
npm install            # 只装测试用的 vitest；生成脚本本身没有依赖
cp .env.example .env   # 填入 LLM_API_KEY 等
npm run update         # 生成 public/data.json（会调用一次大模型）
npm run preview        # http://127.0.0.1:4173/ 预览页面
npm test               # 运行测试
```

直接双击打开 `public/index.html` 时浏览器会拦截读取 `data.json`，需要通过 `npm run preview` 访问。

## 数据来源

- GitHub：优先抓 `github.com/trending?since=daily` 官方页面（唯一带「今日新增 star」的来源，老项目也能上榜）；页面解析失败或改版时退回 isboyjc 每日榜单（2026-08 起已停更，只在数据仍新鲜时使用）；最后兜底到 GitHub Search API 的「近 7 天新建、按 star 排序」，页面会标明实际口径。
- AI 快讯：Hacker News Algolia 接口，过去 24 小时标题含 AI / LLM / Claude / Anthropic 的帖子，按点赞数排序；同一篇文章按归一化 URL 去重，同一域名最多 1 条（不够 5 条再放宽到 2 条），并过滤股市、IPO 等财经标题。
- 分析：OpenAI 兼容协议的大模型（DeepSeek、Kimi 等）。提示词会带上昨天的解读并要求换角度，避免每天复读同一结论；模型失败时仍然发布榜单与快讯，页面标注「解读生成失败」。

## 许可证

[MIT](LICENSE)
