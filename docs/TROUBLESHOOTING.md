# 故障排查

## 改了设置并保存，但要重启 App 才生效

插件解析到了过旧的 `@deepseek-ai/schemastery`（< 3.18.3）时会这样，与插件逻辑无关。

**成因**：宿主 `cordis-plugin-loader` 的热更新路径是——只改 `volatile` 字段时走
`Entry._commitVolatile()`，把新值就地写进 schemastery 生成的响应式引用（cosmokit
`createVolatile`，由 `.volatile()` 在 >= 3.18.3 才会装箱）。3.18.2 没有 `.volatile()`，
`markVolatile()` 退化为 `.extra('volatile', true)`：可编辑标记还在，但没有装箱。
`_commitVolatile()` 收集不到引用便静默 `return true`——插件不重启、值不更新、日志不报错，
于是表现为「保存写盘成功，但只有重启 App（重新 apply）才看到新值」。

**修复**：让插件的四个 `@deepseek-ai` 依赖都指向 DSH 运行时安装
（`dshup/current` 跟随当前版本，升级后自动跟上）：

```bash
cd <插件目录>/node_modules/@deepseek-ai
for p in schemastery dsh-web dsh-llm dsh-credentials; do
  ln -sfn ~/.dsh/dshup/current/node_modules/@deepseek-ai/$p $p
done
```

跨副本是安全的：cosmokit 用 `Symbol.for('cosmokit.volatile.write')` 识别引用。

用插件管理器重装或更新本插件后，这些软链可能被重新指回旧仓库
（`~/.dsh/profiles/node_modules/...` → `dshup/versions/0.1.5-rc.3`）。生效异常时先自检：

```bash
ls -l <插件目录>/node_modules/@deepseek-ai/
# 四条都应指向 ~/.dsh/dshup/current/...；出现 dshup/versions/0.1.5-rc.3 就是又被指回去了
```

**自检**（在插件目录里跑）：应打印 `object 3`；`object` 表示已装箱，`number 3` 表示没装箱。

```bash
node -e "import('./index.js').then(m=>{const v=m.Config['~standard'].validate({}).value.maxQueries; console.log(typeof v, v && typeof v.get==='function' ? v.get() : v)})"
```

`apply()` 启动时也会探测一次，未装箱会在宿主日志里打印 warn。

## 搜索没有走会话模型

依次检查：

1. `web` 行的 `searchProvider` 是否为 `session`；
2. 配置项 `providerId` 是否与该值一致；
3. 当前会话是否已有 provider/model 路由（无路由时按 `noRoute` 处理，默认回退官方）；
4. `sessionPlanning` 是否为 `true`。

## 检索后端无结果

- 确认 `endpoint` 指向的后端可访问，且 `/search?q=test&format=json` 返回 JSON。
- Tavily / Brave 需先配置密钥，否则抛 `WEB_PROVIDER_CREDENTIAL_MISSING`（该错误不回退官方）。
- 打开 `debug: true` 可在宿主日志中看到检索词与实际来源数。
