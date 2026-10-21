# Social Learning

一个本机优先的小工具，用于学习 X 上公开主页的活动节奏：访问某个 profile 时，Chrome 插件会把当前页面可见的公开元数据写入本机服务端和 SQLite 数据库。

默认不会保存点赞/回复用户身份。当前版本保存的是：profile handle/name、访问时间、可见帖子的正文、发布时间、帖子链接、内容类型推断，以及页面上显示的回复/转发/点赞/浏览等计数。

## 启动

```bash
npm start
```

服务默认监听：

```text
http://127.0.0.1:3197
```

SQLite 数据库会创建在：

```text
data/social-learning.sqlite
```

## 安装 Chrome 插件

1. 打开 `chrome://extensions`
2. 开启 Developer mode
3. 选择 Load unpacked
4. 选择本仓库的 `extension` 目录
5. 保持本地服务端运行，然后访问 `https://x.com/{handle}`

插件 popup 里可以临时关闭记录、手动抓取当前页、启动慢速滚动采集，也可以打开本地面板。

popup 诊断数字的含义：

- `Articles`：当前 X 页面里发现的帖子容器数量。
- `Parsed`：成功解析成帖子记录的数量。
- `Sent`：本次已经写入本地服务端的数量。

如果 `Articles` 是 0，说明插件没有看到 timeline DOM，先刷新 X 页面或确认当前标签页是 profile 页。如果 `Articles > 0` 但 `Parsed` 是 0，说明 X 页面结构变了，需要更新解析规则。如果 `Parsed > 0` 但 `Sent` 是 0，通常是这些帖子已经记录过，或者服务端没有运行。

## 本地面板

浏览器打开：

```text
http://127.0.0.1:3197
```

可以查看：

- profile 列表
- 每天观察到的内容数量
- 内容关键词、hashtag、mention 统计
- 小时分布
- 已抓取的 timeline 帖子正文和互动计数
- JSON 导出

## API

```text
GET  /health
POST /api/profile-observation
POST /api/timeline-observations
GET  /api/profiles
GET  /api/profiles/:handle?days=30
GET  /api/events?limit=100
GET  /api/export.json
```

## Git remote

仓库 remote 指向：

```text
https://github.com/AM-young-fun/social-learning.git
```

如果你有推送权限：

```bash
git push -u origin main
```

## 注意

这个项目面向学习和本机样本分析。请只采集你能正常访问的公开页面，不要绕过登录、权限、频率限制或平台规则。
