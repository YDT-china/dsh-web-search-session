# 开发与内部机制

## 文件

| 文件 | 运行位置 | 作用 |
| --- | --- | --- |
| `index.js` | 宿主（Node） | 检索提供方、配置 schema、回退逻辑 |
| `client.js` | 浏览器 | 插件页配置表单 |
| `cordis.patch.yml` | 宿主 | bundle patch：覆盖 `web` 行、插入插件行 |
| `.e2e.mjs` | 开发机 | 端到端测试脚本（不随包发布） |

## bundle patch

`cordis.patch.yml` 做两件事：

1. 覆盖已存在的 `web` 行，把 `searchProvider` 切到 `session`。
   Loader 按 id 覆盖时**整段替换 config，不做深合并**，因此 `fetchProvider` 必须重申。
2. 插入 `web-search-session` 插件行。

## 配置界面

`client.js` 把配置表单注册进 `plugins.bundle.config` 槽，key 取包名 `dsh-web-search-session`。
插件页以槽位注册项的 key 建集合，再与 profile 中已安装包的**包名**比对来判定「已配置」，
因此注册 key 必须与包名完全一致。

槽位注册的字段标记：

- 能出现在界面上的字段标 `.volatile()`（设置命名空间可编辑）；
- 密钥字段另标 `.role('secret')`；
- 引用名字段标 `.role('credential-ref')`。

密钥的字面量只朝凭据服务单向写入，读路径只返回「配没配」，因此不会落进设置文件。

## 热重载

- 改 `index.js`（宿主半身）需重启 DSH。
- 改 `client.js`（浏览器产物）需刷新页面；若正在运行 `pnpm run dev:web`，客户端产物热重载。

## 验收

1. 搜索时辅助 `llm.stream` 的 `provider/model` 等于当前会话路由（开 `debug: true` 看日志）。
2. `$DSH_HOME/storages/cost-meter/ledger.json` 出现带当前 sessionId、模型为会话模型的记录。
3. 搜索结果正常返回；取消、超时、无路由各分支行为明确。
4. 会话详情页不作为该辅助调用计费可见性的验收依据（会话投影只折叠
   assistant/chunk、assistant/message、native-search-usage、compaction/summary 四类事件）。
5. 无会话路由时回退官方；官方也不可用时抛结构化 `WebError`。

## 已知边界

- 回退路径读 `ctx.web.searchProviders`，属 seam 的非公开字段；官方若改结构，回退失效但主路径不受影响
  （默认 `noRoute: official` 时可改成 `raw` 或 `error`）。
- `ctx.llm.stream` 的 `purpose: 'web-search'` 只是标记，计费与 purpose 无关。
- 内核 API 漂移可能让本插件失效（而非被覆盖）；若官方日后自带「跟随会话」的能力，应卸载本插件。
- 界面只暴露地址 / 密钥 / 调用次数三项；`backend` 仍在 patch 里选。`backend` 已标 `volatile`，
  日后加下拉框不需要改宿主。

## 回滚

把 `web` 行的 `searchProvider` 改回 `deepseek-official`，或移除本 bundle（覆盖随之消失）。
