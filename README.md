# dsh-web-search-session

DSH 自带的联网搜索消耗官方 token 额度：即便已经自配网关，这部分调用仍按官方口径计费，
长期使用会在不知不觉中产生费用。

本插件让联网搜索跟随**当前会话所选模型**：先由会话模型把问题改写为检索词
（该次调用同样计入 dsh-cost-meter 账本并归入本会话），再通过自建检索后端取回真实网页来源。

## 特性

- **会话路由** —— 改写检索词时使用当前会话的 provider/model，而非固定模型。
- **自建检索** —— 支持 SearXNG（免密钥，推荐）、Tavily、Brave，端点与密钥均可配置。
- **可控回退** —— 无会话路由或检索失败时，按 `noRoute` 选择回退官方提供方、用原始问题检索或直接报错。
- **凭据隔离** —— 密钥仅通过凭据服务或环境变量引用，不写入插件与设置文件。
- **可视化配置** —— 在「插件」页直接配置地址、密钥与调用次数。

## 安装

```bash
dsh plugin add dsh-web-search-session
```

安装后重启 DSH。插件通过 bundle patch 把 `web` 行的 `searchProvider` 切换为 `session`。

**从源码安装**：在具备 `plugin_manager` 工具的会话中，对插件目录执行 `install_bundle`，
`target` 填目录绝对路径。安装会写入当前 profile 并应用 patch，无需手工编辑配置文件。

## 快速开始

1. 准备一个 SearXNG 实例，确认 `http://<host>:8888/search?q=test&format=json` 返回 JSON。
2. 打开「插件 → 已安装 → dsh-web-search-session」，把平台地址指向该实例。
3. 正常发起一次联网搜索。

## 配置

配置项写在 profile 的 `cordis.patch.yml` 中；标有「界面」的项也可在插件页直接修改。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `backend` | string | `none` | 检索后端：`none` / `searxng` / `tavily` / `brave` |
| `endpoint` | string | `''` | 后端基址；留空时使用该后端默认端点 |
| `apiKeyEnv` | string | `''` | 密钥引用名；留空时使用该后端默认名 |
| `sessionPlanning` | boolean | `true` | 是否用会话模型改写检索词 |
| `noRoute` | string | `official` | 无路由或检索失败时：`official` / `raw` / `error` |
| `providerId` | string | `session` | 本插件注册的提供方 id，须与 `web.searchProvider` 一致 |
| `officialProviderId` | string | `deepseek-official` | 回退时委派的官方提供方 id |
| `maxQueries` | number | `3` | 单次请求最多调用后端几次，范围 1–20 |
| `maxResults` | number | `8` | 返回来源条数上限，最大 20 |
| `planMaxTokens` | number | `512` | 检索词改写的输出 token 上限 |
| `planTimeoutMs` | number | `20000` | 检索词改写超时（毫秒） |
| `searchTimeoutMs` | number | `20000` | 单次后端检索超时（毫秒） |
| `debug` | boolean | `false` | 输出检索词与来源数量的调试日志 |

> 随包提供的 `cordis.patch.yml` 已预设 `backend: searxng`、`endpoint: http://127.0.0.1:8888`。
> 上表「默认」列是插件 schema 的缺省值；未加载该 patch 时以缺省值为准。

### 后端

| 后端 | 默认端点 | 密钥变量 |
| --- | --- | --- |
| `searxng` | `http://127.0.0.1:8888` | 不需要 |
| `tavily` | `https://api.tavily.com` | `TAVILY_API_KEY` |
| `brave` | `https://api.search.brave.com` | `BRAVE_API_KEY` |

### 凭据

密钥不写入插件或设置文件，按以下优先级解析：

1. 凭据服务，引用名取 `apiKeyEnv`，留空时取该后端的默认名；
2. 同名环境变量。

缺少凭据属确定性配置错误，不会静默回退官方提供方。

## 工作原理

1. 读取当前会话的 provider/model 路由。
2. 由该模型把用户问题改写为若干检索词，受 `sessionPlanning` 与 `maxQueries` 约束。
3. 并发调用所选后端，按 URL 去重后返回不超过 `maxResults` 条来源。
4. 任一步骤失败时按 `noRoute` 处理。

## 兼容性

- Node.js >= 20
- DSH >= 0.1.7-rc.2（该版本起内置 `@deepseek-ai/schemastery` >= 3.18.3，设置项的即时生效依赖其 `.volatile()`）

## 文档

- [开发与内部机制](docs/DEVELOPMENT.md)
- [故障排查](docs/TROUBLESHOOTING.md)

## 许可

[MIT](LICENSE)
