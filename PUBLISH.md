# 发布手册 — dsh-web-search-session

"DSH 插件库" 实际由三层组成，按需执行：

| 层 | 作用 | 需要什么 |
| --- | --- | --- |
| GitHub 仓库 | 源码主页；catalog 条目 url 指向它 | GitHub 账号 |
| npm registry | `dsh plugin add dsh-web-search-session` 的安装源 | npm 账号 |
| awesome-dsh-plugin 目录 | dshmarket 插件市场的数据源（投稿） | GitHub 账号 + PR |

## 0. 发布前校验（无需凭据）

```bash
cd /Users/mr.ye/work/11-AI/dsh-web-search-session
npm pack --dry-run --cache /tmp/npm-cache-dsh
node -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

## 1. 建 GitHub 仓库并推送

本机当前**没有任何 GitHub 凭据**（无 gh CLI、无 ssh key、无 token）。二选一：

**A. 装 gh 并登录**
```bash
brew install gh
gh auth login
gh repo create dsh-web-search-session --public --source=. --push
```

**B. 网页建仓 + PAT 推送**
1. 打开 https://github.com/new ，owner 选 `yedaotian`，仓库名 `dsh-web-search-session`，Public，
   **不要**勾选 Add a README / .gitignore / license（本仓库已有）。
2. 生成 fine-grained PAT，权限 repo → Contents: Read and write。
3. ```bash
   cd /Users/mr.ye/work/11-AI/dsh-web-search-session
   git remote add origin https://github.com/yedaotian/dsh-web-search-session.git
   git push -u origin main    # 提示 Password 时粘贴 PAT
   ```

> 若最终 owner/repo 不是 `yedaotian/dsh-web-search-session`：依次改
> `package.json` 的 repository/homepage/bugs、
> `contrib/yedaotian__dsh-web-search-session.yml` 的 url/name 与文件名、
> `README.md` 里的链接，再重新提交。

## 2. 发布到 npm

本机默认 registry 是 npmmirror 镜像，**必须显式指定官方源**：

```bash
cd /Users/mr.ye/work/11-AI/dsh-web-search-session
npm login   --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --access public
```

校验：
```bash
npm view dsh-web-search-session version --registry=https://registry.npmjs.org/
```

发布后任意机器都可安装：
```bash
dsh plugin add dsh-web-search-session
```

> 若 npm 报 EPERM "Your cache folder contains root-owned files"：
> `sudo chown -R 501:20 ~/.npm`，或加 `--cache /tmp/npm-cache-dsh`。

## 3. 收录进 awesome-dsh-plugin（dshmarket 市场数据源）

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 新增文件 `data/plugins/yedaotian__dsh-web-search-session.yml`，
   内容拷贝本仓库 `contrib/yedaotian__dsh-web-search-session.yml`。
3. 提 PR。**不要**手改 README（由 `node scripts/generate-readme.mjs` 生成）。

收录硬性要求（均已满足）：`package.json` 声明 `dsh.bundle`（本插件为 `dsh.bundle.patch`）、
可被 `dsh plugin add` 安装、描述与行为一致、有人维护。
最常见的被拒原因：只声明 `dsh.client` 而漏了 `dsh.bundle`。

## 4. 本机 profile 从 link 切到发布版（可选）

当前 `~/.dsh/profiles/web/package.json` 是
`"dsh-web-search-session": "link:/Users/mr.ye/work/11-AI/dsh-web-search-session"`。
npm 发布后可切成版本号：

```bash
dsh plugin --profile web add dsh-web-search-session@0.1.0
```

注意：`dsh plugin` 要写 workspace 之外的 `~/.dsh/profiles/web/`，
在 DSH 沙箱（workspace-write）下会 EPERM，须在普通终端执行。

## 5. 回滚

把 `cordis.patch.yml` 注入的 `web` 行 `searchProvider` 改回 `deepseek-official`（或卸载插件）即可。
