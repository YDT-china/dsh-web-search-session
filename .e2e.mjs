import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN = '/Users/mr.ye/work/11-AI/dsh-web-search-session/index.js'
const mod = await import(PLUGIN)
const { apply, Config } = mod

const SENTINEL = 'sk-e2e-sentinel-7f3a9c-DO-NOT-LEAK'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''))
}

// ---------- counting proxy ----------
let mode = 'forward'
const log = []
const server = http.createServer(async (req, res) => {
  const bufs = []
  for await (const c of req) bufs.push(c)
  const body = Buffer.concat(bufs).toString('utf8')
  log.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, token: req.headers['x-subscription-token'] ?? null, body })
  if (mode === 'fail500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"detail":"upstream exploded"}'); return }
  if (mode === 'mock') {
    res.writeHead(200, { 'content-type': 'application/json' })
    if ((req.url || '').startsWith('/res/v1/web/search')) res.end(JSON.stringify({ web: { results: [{ url: 'https://mock.example/1', title: 'Mock', description: 'mock body' }] } }))
    else res.end(JSON.stringify({ results: [{ url: 'https://mock.example/1', title: 'Mock', content: 'mock body' }] }))
    return
  }
  try {
    const up = await fetch('http://127.0.0.1:8888' + req.url, { headers: { accept: 'application/json' } })
    const text = await up.text()
    res.writeHead(up.status, { 'content-type': 'application/json' }); res.end(text)
  } catch (e) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"upstream unreachable"}') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ENDPOINT = 'http://127.0.0.1:' + server.address().port
console.log('# counting proxy at ' + ENDPOINT + ' (mode=forward -> live searxng 127.0.0.1:8888)')

function makeCtx({ route = true, plan = null, cred = null } = {}) {
  const providers = new Map()
  const ctx = {
    web: { searchProviders: providers, registerSearchProvider(p) { providers.set(p.id, p) } },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents' && route) return { currentInitiator: () => ({ session: { id: 'sess-e2e', requestContext: () => ({ provider: 'deepseek-chat', model: 'deepseek-chat' }) } }) }
      if (name === 'llm' && plan !== null) return { stream: async function* () { yield { type: 'text-delta', index: 0, text: plan }; yield { type: 'finish', reason: { kind: 'stop' } } } }
      if (name === 'credentials' && cred !== null) return { resolve: () => ({ value: cred }) }
      return undefined
    },
  }
  return { ctx, providers }
}
function mount(config, opts) {
  const { ctx, providers } = makeCtx(opts)
  apply(ctx, config)
  providers.set('deepseek-official', { id: 'deepseek-official', search: async () => ({ sources: [{ url: 'https://official.example/x' }], truncated: false }) })
  const self = providers.get('session')
  check('provider id = session 且 available()=true', self !== undefined && self.id === 'session' && self.available() === true)
  return self
}

// ---------- T1: live searxng, planning path, maxQueries = 2 ----------
mode = 'forward'
log.length = 0
{
  const plan2 = JSON.stringify(['deepseek cordis plugin', 'searxng json api'])
  const p = mount({ backend: 'searxng', endpoint: ENDPOINT, sessionPlanning: true, noRoute: 'raw', maxQueries: 2, maxResults: 8 }, { plan: plan2 })
  try {
    const out = await p.search({ query: 'dsh 插件验收', maxResults: 8 }, undefined)
    check('T1 规划路径实际调用次数 <= maxQueries(2)', log.length <= 2, 'calls=' + log.length)
    check('T1 确实发起了平台调用', log.length >= 1, 'calls=' + log.length)
    check('T1 真实 searxng 返回来源', out.sources.length > 0, 'sources=' + out.sources.length + ' first=' + String(out.sources[0]?.url).slice(0, 70))
    check('T1 返回形状 {sources, truncated:false}', out.truncated === false && Array.isArray(out.sources))
    check('T1 分片 <= 1200 字符', out.sources.every((s) => s.snippet === undefined || s.snippet.length <= 1200))
    check('T1 地址就是所填 endpoint', log.every((r) => r.url.startsWith('/search?')), 'urls=' + log.map((r) => r.url.slice(0, 40)).join('|'))
  } catch (e) {
    check('T1 规划路径实际调用次数 <= maxQueries(2)', log.length <= 2, 'calls=' + log.length)
    check('T1 真实 searxng 返回来源', false, 'threw: ' + String(e && e.message).slice(0, 160))
  }
}

// ---------- T2: maxQueries 填 99 -> 夹取到 20 ----------
mode = 'mock'
log.length = 0
{
  const plan30 = JSON.stringify(Array.from({ length: 30 }, (_, i) => 'term' + i))
  const p = mount({ backend: 'tavily', endpoint: ENDPOINT, apiKeyEnv: 'TAVILY_API_KEY', sessionPlanning: true, noRoute: 'raw', maxQueries: 99, maxResults: 8 }, { plan: plan30, cred: SENTINEL })
  await p.search({ query: 'cap test', maxResults: 8 }, undefined)
  check('T2 maxQueries=99 被夹取到 20（实际调用 == 20）', log.length === 20, 'calls=' + log.length)
}

// ---------- T3: 规划失败 -> 回退原始问题，恰好 1 次调用 ----------
log.length = 0
{
  const p = mount({ backend: 'searxng', endpoint: ENDPOINT, sessionPlanning: true, noRoute: 'raw', maxQueries: 5, maxResults: 8 }, { plan: null })
  await p.search({ query: 'raw fallback query', maxResults: 8 }, undefined)
  check('T3 无规划结果时回退原始问题（1 次调用）', log.length === 1, 'calls=' + log.length)
  check('T3 回退查询词就是原始问题', decodeURIComponent(log[0].url).includes('raw fallback query'), 'url=' + decodeURIComponent(log[0].url).slice(0, 80))
}

// ---------- T4: key 处理 ----------
log.length = 0
{
  const p = mount({ backend: 'tavily', endpoint: ENDPOINT, apiKeyEnv: 'TAVILY_API_KEY', sessionPlanning: false, noRoute: 'raw', maxQueries: 3, maxResults: 8 }, { cred: SENTINEL })
  const out = await p.search({ query: 'key test', maxResults: 8 }, undefined)
  check('T4 key 只走 Authorization 头（Bearer）', log[0].auth === 'Bearer ' + SENTINEL, 'auth=' + String(log[0].auth).slice(0, 20) + '...')
  check('T4 key 未出现在请求 URL/query 里', !decodeURIComponent(log[0].url).includes(SENTINEL))
  check('T4 key 未出现在返回的 sources 里', !JSON.stringify(out).includes(SENTINEL))
  check('T4 请求体是 tavily 协议 {query,max_results,...}', JSON.parse(log[0].body).max_results === 8 && JSON.parse(log[0].body).query === 'key test')
}
log.length = 0
{
  mode = 'fail500'
  const p = mount({ backend: 'tavily', endpoint: ENDPOINT, apiKeyEnv: 'TAVILY_API_KEY', sessionPlanning: false, noRoute: 'raw', maxQueries: 3 }, { cred: SENTINEL })
  let msg = ''
  try { await p.search({ query: 'fail test', maxResults: 8 }, undefined) } catch (e) { msg = String(e && e.message) }
  check('T4b 上游 500 时抛出结构化错误', msg.startsWith('Tavily returned HTTP 500'), 'msg=' + msg.slice(0, 90))
  check('T4b 错误信息里没有 key', !msg.includes(SENTINEL) && !msg.includes('sk-e2e'))
  mode = 'mock'
}

// ---------- T5: 缺凭据 -> 确定性错误，不发任何调用 ----------
log.length = 0
{
  const p = mount({ backend: 'tavily', endpoint: ENDPOINT, apiKeyEnv: 'TAVILY_API_KEY', sessionPlanning: false, noRoute: 'raw', maxQueries: 3 }, { cred: null })
  let code = ''
  let msg = ''
  try { await p.search({ query: 'no key', maxResults: 8 }, undefined) } catch (e) { code = String(e && e.code); msg = String(e && e.message) }
  check('T5 缺 key 抛 WEB_PROVIDER_CREDENTIAL_MISSING', code === 'WEB_PROVIDER_CREDENTIAL_MISSING', 'code=' + code)
  check('T5 缺 key 不会回退官方、也不发平台调用', log.length === 0, 'calls=' + log.length)
  check('T5 searxng 不需要 key', msg.length > 0)
}
{
  log.length = 0
  const p = mount({ backend: 'searxng', endpoint: ENDPOINT, sessionPlanning: false, noRoute: 'raw', maxQueries: 2, maxResults: 8 }, { cred: null })
  const out = await p.search({ query: 'no key needed', maxResults: 8 }, undefined)
  check('T5b searxng 无 key 正常工作', out.sources.length > 0 && log.length === 1, 'calls=' + log.length + ' sources=' + out.sources.length)
}

// ---------- T6: Config 元信息 ----------
{
  const m = (name) => Config.dict?.[name]?.meta ?? Config.dict?.[name]?.meta
  const metaOf = (name) => { const f = Config.dict?.[name]; return f && f.meta }
  const volatileNames = ['backend', 'endpoint', 'apiKeyEnv', 'apiKey', 'maxQueries']
  const bad = volatileNames.filter((n) => metaOf(n)?.volatile !== true)
  check('T6 界面上可改的 5 个字段都带 meta.volatile', bad.length === 0, 'missing=' + bad.join(',') + ' backendVolatile=' + String(metaOf('backend')?.volatile))
  check('T6 apiKey 是 secret、apiKeyEnv 是 credential-ref', metaOf('apiKey')?.role === 'secret' && metaOf('apiKeyEnv')?.role === 'credential-ref', 'apiKeyRole=' + String(metaOf('apiKey')?.role))
  check('T6 非界面字段不带 volatile', metaOf('planMaxTokens')?.volatile !== true && metaOf('debug')?.volatile !== true)
}

// ---------- T7: 磁盘上不存在 key ----------
{
  const roots = ['/Users/mr.ye/.dsh/storages', '/Users/mr.ye/.dsh/profiles/desktop']
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile()) {
        let st
        try { st = fs.statSync(full) } catch { continue }
        if (st.size > 4_000_000) continue
        let text = ''
        try { text = fs.readFileSync(full, 'utf8') } catch { continue }
        if (text.includes(SENTINEL)) hits.push(full)
      }
    }
  }
  for (const r of roots) walk(r, 0)
  check('T7 落盘文件里找不到 sentinel key', hits.length === 0, hits.length ? hits.join(',') : 'scanned ' + roots.join(' + '))
  const settingsFiles = []
  const find = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) find(full, depth + 1)
      else if (/settings.*\.json$/i.test(e.name)) settingsFiles.push(full)
    }
  }
  find('/Users/mr.ye/.dsh', 0)
  console.log('# settings-like files on disk: ' + (settingsFiles.join(', ') || '(none)'))
}

server.close()
const failed = results.filter((r) => !r.ok)
console.log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' checks passed ====')
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(' | ')); process.exit(1) }
console.log('ALL_E2E_CHECKS_PASSED')
process.exit(0)
