# dsh-web-search-session

dsh本身自带的web搜索功能会消耗自身的token，在自己配置网关以后依然走自己的token，不知不觉消耗资金，所以做了这个插件，让联网搜索跟随**当前会话所选模型**：先由会话模型把问题改写成检索词（这次调用同样计入
dsh-cost-meter 账本并归入本会话），再用自建检索后端取回真实网页来源。

## 它改了什么

- 新增一行 `web-search-session`（本插件）。
- 覆盖既有 `web` 行：`searchProvider` 从 `deepseek-official` 改为 `session`；
  `fetchProvider` 保持 `http`（覆盖是整段替换 config，必须重申）。

## 安装

从 npm 安装：

```bash
dsh plugin add dsh-web-search-session
```

本地开发安装：

在具备 `plugin_manager` 工具的会话里（PTC 创造模式等），对该目录执行
`install_bundle`，`target` 为绝对路径：

    /path/to/dsh-web-search-session

安装会写入当前 profile（`install_bundle` 自己处理 package.json / patch，别手工改）。
之后读它返回的 `application` 与 `warnings`：`applied` 才代表生效。

## 配置（改 profile 的 cordis.patch.yml 或安装时给出的 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `searxng` | `none` / `searxng` / `tavily` / `brave` |
| `endpoint` | `http://127.0.0.1:8888` | SearXNG 基址（其余后端留空即用官方端点） |
| `apiKeyEnv` | 空 | 密钥环境变量名，空表示用后端默认名 |
| `sessionPlanning` | `true` | 是否用会话模型改写检索词 |
| `noRoute` | `official` | 无路由/检索失败时：`official` / `raw` / `error` |
| `providerId` | `session` | 必须与 `web.searchProvider` 一致 |
| `officialProviderId` | `deepseek-official` | 回退委派的官方提供方 |
| `maxQueries` / `maxResults` | `3` / `8` | 单次请求最多调用第三方平台几次（1–20）/ 结果条数上限 |

`maxQueries` 是硬上限：规划出的检索词会被夹到该值以内，规划失败退回单条原始问题时也只
调用平台 1 次，所以实际调用次数不会超过它。

## 界面配置（侧栏「插件」→「已安装」→ 本插件）

本插件的浏览器半身 `client.js` 把配置表单挂在**本插件自己的条目**上：注册进
`plugins.bundle.config` 槽，key 取包名 `dsh-web-search-session`，表单渲染在该包
详情页的说明与组件列表之间。它**不再**占用 `plugins.item`——那个槽是官方设置页
的地盘（插件页「官方」组），bundle 自己的配置按槽位契约本就该走
`plugins.bundle.config` / `plugins.row.config`。

三个控件：

| 控件 | 写到哪里 |
| --- | --- |
| 平台地址 | 设置命名空间的 `endpoint`（与 patch 里的 `endpoint` 同一个字段） |
| API Key | 凭据服务，引用名 = `apiKeyEnv`（留空时用该后端的默认名，如 `TAVILY_API_KEY`） |
| 单次请求最多调用次数 | 设置命名空间的 `maxQueries`（1–20） |

要点：

- 能出现在界面上的字段，宿主 Config 里都标了 `.volatile()`；密钥字段另标
  `.role('secret')`，引用名字段标 `.role('credential-ref')`。
- **密钥不进设置文件**：它的字面量只朝凭据服务单向写入，读路径只回"配没配"。
- 卡片只在宿主服务起本行的设置命名空间时出现（`configForms.whileServed`）；命名空间
  就是插件行条目 id，客户端不 import 宿主包，所以 `web-search-session` 与
  `dsh-web-search-session` 两种写法都兜。
- 表单要出现在插件详情页，前提是插件页侧的 `ledger.bundles` 认为这个包"已配置"：
  它以槽位注册项的 key 建集合，再与 profile 里已安装包的**包名**比对，所以注册 key
  必须正好等于包名 `dsh-web-search-session`。
- 改 `index.js`（宿主半身）要重启 dsh；改 `client.js`（浏览器产物）要刷新页面
  （除非正在跑 `pnpm run dev:web`，那时客户端产物热重载）。

`official` 回退只用于偶发失败。**缺少凭据（`WEB_PROVIDER_CREDENTIAL_MISSING`）是确定性的配置错误，永不回退**，直接抛出原错误；若回退本身也失败，抛出的 `WebError` 会同时包含两侧原因，`cause` 指向原始的检索错误。

安装后第一步只做一件事：把 `endpoint` 指向你的 SearXNG 实例（默认 `http://127.0.0.1:8888`），并确认该实例 `/search?q=x&format=json` 能返回 JSON。

- SearXNG（推荐，无需密钥）：`backend: searxng`，`endpoint: http://127.0.0.1:8888`
- Tavily：`backend: tavily`，`apiKeyEnv: TAVILY_API_KEY`
- Brave：`backend: brave`，`apiKeyEnv: BRAVE_API_KEY`

密钥只通过环境变量 / 凭据服务（界面上的 API Key 输入框也走凭据服务）引用，不写进插件或 patch。

## 验收

1. 搜索时辅助 `llm.stream` 的 `provider/model` 等于当前会话路由（开 `debug: true` 看日志）。
2. `$DSH_HOME/storages/cost-meter/ledger.json` 出现带当前 sessionId、模型为会话模型的记录。
3. 搜索结果正常返回；取消、超时、无路由各分支行为明确。
4. 会话详情页**不**作为该辅助调用计费可见性的验收依据（会话投影只折叠
   assistant/chunk、assistant/message、native-search-usage、compaction/summary 四类事件）。
5. 无会话路由时回退官方；官方也不可用时抛结构化 `WebError`。

## 故障排查

**设置卡片里改了数字，保存后要重启 App 才生效？** 这是插件解析到了过旧的
`@deepseek-ai/schemastery`（< 3.18.3）导致的，与插件自身逻辑无关。

- 宿主 `cordis-plugin-loader` 的热更新路径是：只改了 `volatile` 字段时走
  `Entry._commitVolatile()`，把新值**就地**写进 schemastery 生成的响应式引用
  （cosmokit `createVolatile`，由 `.volatile()` 在 ≥3.18.3 才会装箱）。
- 3.18.2 没有 `.volatile()`，`markVolatile()` 会退化成 `.extra('volatile', true)`：
  可编辑的标记还在，但**没有装箱**。`_commitVolatile()` 收集不到引用就静默
  `return true` —— 插件不重启、值不更新、日志不报错，于是表现为「保存写盘成功，
  但只有重启 App（重新 apply）才看到新值」。
- 修复：让插件的四个 `@deepseek-ai` 依赖都指向 DSH 运行时安装（`dshup/current` 跟着
  当前版本走，升级后自动跟上）：

      cd <插件目录>/node_modules/@deepseek-ai
      for p in schemastery dsh-web dsh-llm dsh-credentials; do
        ln -sfn ~/.dsh/dshup/current/node_modules/@deepseek-ai/$p $p
      done

  跨副本是安全的：cosmokit 用 `Symbol.for('cosmokit.volatile.write')` 识别引用。
- 用插件管理器重装/更新本插件后，这些软链可能被重新指回旧仓库
  （`~/.dsh/profiles/node_modules/...` → `dshup/versions/0.1.5-rc.3`）；生效异常时先自检：

      ls -l <插件目录>/node_modules/@deepseek-ai/
      # 四条都应指向 ~/.dsh/dshup/current/...；出现 dshup/versions/0.1.5-rc.3 就是又被指回去了
- 自检（在插件目录里跑）：应打印 `object 3`，`object` 表示已装箱；打印 `number 3` 就是没装箱。

      node -e "import('./index.js').then(m=>{const v=m.Config['~standard'].validate({}).value.maxQueries; console.log(typeof v, v && typeof v.get==='function' ? v.get() : v)})"

- `apply()` 启动时也会探测一次，未装箱会在宿主日志里打印 warn。

## 回滚

把 `web` 行的 `searchProvider` 改回 `deepseek-official`（或移除本 bundle，
覆盖随之消失）。

## 已知边界

- 回退路径读 `ctx.web.searchProviders`，属 seam 的非公开字段；官方若改结构，回退失效
  但主路径不受影响（默认 `noRoute: official` 时可改成 `raw` 或 `error`）。
- `ctx.llm.stream` 的 `purpose: 'web-search'` 只是标记；dsh-cost-meter 计费与 purpose 无关。
- 内核 API 漂移可能让本插件失效（不是被覆盖）；若官方日后自带"跟随会话"的能力，
  应卸载本插件。
- 界面只暴露地址 / 密钥 / 调用次数三项；`backend`（searxng / tavily / brave）仍在
  patch 里选。`backend` 已标 `volatile`，日后要加下拉框不需要再改宿主。
- `searxng` 默认不需要密钥，所以密钥输入框在该后端下是禁用状态并说明原因；要给自建
  SearXNG 配密钥就先在 patch 里填 `apiKeyEnv`。
