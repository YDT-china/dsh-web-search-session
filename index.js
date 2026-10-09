/**
 * dsh-web-search-session —— 让联网搜索跟随"当前会话所选模型"。
 *
 * 背景：官方 dsh-web-search-deepseek 的后端是它自己的 endpoint + model
 * （Anthropic Messages + web_search_20250305 服务端工具），与当前会话的路由无关。
 * 本插件注册一个 id 为 `session` 的搜索提供方接管 ctx.web.search：
 *
 *   1. 读当前会话路由 agents.currentInitiator().session.requestContext()；
 *   2. 有路由：用 ctx.llm.stream({ provider, model, sessionId }) 让当前会话模型把
 *      问题改写成若干检索词。该调用同样经过全局 llm/stream，因此进入 dsh-cost-meter
 *      账本，并按 sessionId 归入本会话；
 *   3. 用自建检索后端（searxng / tavily / brave）取回真实网页来源；
 *   4. 无路由或检索失败时按 `noRoute` 处理：official 委派官方提供方 /
 *      raw 直接用原始问题检索 / error 抛结构化 WebError。
 *
 * 设计约束（见 cordis-plugin-development/references/host-plugin.md）：
 *   - 只声明 inject: ['web']；llm / agents / credentials 调用时按需取，缺失即降级，
 *     不因某个服务缺席而让插件加载失败；
 *   - 绝不调用 ctx.web.search()（会重新解析回本插件 → 无限递归），只调用从 seam
 *     注册表取到的其它提供方对象；
 *   - 所有可调项都在 Config 里，用户改 cordis.patch.yml 即可，升级不丢。
 */
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'web-search-session'
/** 只需要 web seam；其余服务在调用点按需获取。 */
export const inject = ['web']

/** 各检索后端的默认端点与密钥环境变量。 */
const BACKEND_DEFAULTS = {
  tavily: { endpoint: 'https://api.tavily.com', keyEnv: 'TAVILY_API_KEY' },
  brave: { endpoint: 'https://api.search.brave.com', keyEnv: 'BRAVE_API_KEY' },
  searxng: { endpoint: 'http://127.0.0.1:8888', keyEnv: '' },
  none: { endpoint: '', keyEnv: '' },
}
/** 单次 HTTP 响应体的上限，防止异常后端撑爆内存。 */
const MAX_RESPONSE_CHARS = 2_000_000
/** 片段长度上限，避免把整页正文塞进模型上下文。 */
const MAX_SNIPPET_CHARS = 1200
/** 单次请求允许的第三方平台调用次数上限（界面可填 1–20，超出即夹取）。 */
const MAX_QUERIES_CAP = 20
/** 查询改写用的系统指令：只要 JSON 数组，不要散文，不要工具调用。 */
const PLAN_SYSTEM = [
  'You rewrite one user question into short web search queries.',
  'Return ONLY a JSON array of query strings in the language of the question.',
  'No prose, no explanations, no code fences, no tool calls.',
].join('\n')

/**
 * 把字段标记为「可经设置命名空间编辑」。
 * schemastery >=3.18.3 的 .volatile() 除了写 meta.volatile，还会把字段值装箱成响应式引用
 * （cosmokit 的 createVolatile）。这正是「保存后立刻生效、且不重启插件」的机制：宿主的
 * cordis-plugin-loader 在 Entry.update() 里发现只改了 volatile 字段时，走 _commitVolatile()
 * 把新值就地写进引用；dsh-settings 的 plainConfig() 解箱后立刻对外呈现新值。
 * 反之，若插件解析到 3.18.2（只有 .extra 元信息、没有装箱），_commitVolatile() 会因
 * volatileEntries() 为空而静默 return true：既不重启插件也不更新值，表现为「改了要重启
 * App 才生效」。所以本插件的 @deepseek-ai/schemastery 必须解析到 DSH 运行时那份
 * （node_modules 软链指向 ~/.dsh/profiles/desktop/node_modules/...，当前 3.18.4）；
 * 下面的兜底分支只服务于旧环境，apply() 会探测并打印告警。
 */
const markVolatile = (schema) =>
  typeof schema.volatile === 'function' ? schema.volatile() : schema.extra('volatile', true)

export const Config = z.object({
  /** none | searxng | tavily | brave */
  backend: markVolatile(z.string().default('none')),
  /** 覆盖后端基址；空串表示用该后端的默认端点。 */
  endpoint: markVolatile(z.string().default('')),
  /** 覆盖密钥环境变量名；空串表示用该后端的默认名。 */
  apiKeyEnv: markVolatile(z.string().default('').role('credential-ref')),
  /**
   * 密钥本体：只是「插件」页上的暂存位，浏览器半身会把它写进凭据服务（引用名取
   * apiKeyEnv，留空则取该后端的默认名），宿主从不从这里读取，因此密钥不会落进
   * 设置文件，也不会有任何读路径把它带出来。
   */
  apiKey: markVolatile(z.string().default('').role('secret')),
  /** 是否用当前会话模型把问题改写成检索词。 */
  sessionPlanning: z.boolean().default(true),
  /** 无会话路由 / 检索失败时的策略：official | raw | error。 */
  noRoute: z.string().default('official'),
  /** 本插件注册的提供方 id，必须与 web 行的 searchProvider 一致。 */
  providerId: z.string().default('session'),
  /** 回退时委派的官方提供方 id。 */
  officialProviderId: z.string().default('deepseek-official'),
  /** 单次搜索最多调用第三方平台几次：界面可填 1–20，实际调用次数不会超过它。 */
  maxQueries: markVolatile(z.number().default(3)),
  maxResults: z.number().default(8),
  planMaxTokens: z.number().default(512),
  planTimeoutMs: z.number().default(20000),
  searchTimeoutMs: z.number().default(20000),
  debug: z.boolean().default(false),
})

/** cosmokit 的跨副本标记：volatile 引用上都带这个 Symbol。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
/** 宿主的热更新依赖 volatile 字段被装箱；这里实测一次，仅用于旧环境告警。 */
function hasVolatileRefs() {
  try {
    const parsed = Config['~standard'].validate({}).value
    const value = parsed === undefined || parsed === null ? undefined : parsed.maxQueries
    return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
  } catch (error) {
    return false
  }
}

/** 读一个配置字段，兼容"普通值"与"带 .get() 的响应式字段"两种形态。 */
function readField(config, key, fallback) {
  const raw = config === undefined || config === null ? undefined : config[key]
  const value = raw !== undefined && raw !== null && typeof raw.get === 'function' ? raw.get() : raw
  return value === undefined || value === null ? fallback : value
}
function readString(config, key, fallback) {
  const value = readField(config, key, undefined)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}
function readPositiveInt(config, key, fallback) {
  const value = readField(config, key, undefined)
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
function readBool(config, key, fallback) {
  const value = readField(config, key, undefined)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}
/** 去掉末尾斜杠，便于拼接路径。 */
function withoutTrailingSlash(value) {
  return value.replace(/\/+$/u, '')
}
/** 把整份配置解析成一份不可变快照。 */
function settingsOf(config) {
  const requested = readString(config, 'backend', 'none').toLowerCase()
  const backend = Object.prototype.hasOwnProperty.call(BACKEND_DEFAULTS, requested) ? requested : 'none'
  const defaults = BACKEND_DEFAULTS[backend]
  const noRoute = readString(config, 'noRoute', 'official').toLowerCase()
  return Object.freeze({
    backend,
    endpoint: withoutTrailingSlash(readString(config, 'endpoint', defaults.endpoint)),
    apiKeyEnv: readString(config, 'apiKeyEnv', defaults.keyEnv),
    sessionPlanning: readBool(config, 'sessionPlanning', true),
    noRoute: noRoute === 'raw' || noRoute === 'error' ? noRoute : 'official',
    providerId: readString(config, 'providerId', 'session'),
    officialProviderId: readString(config, 'officialProviderId', 'deepseek-official'),
    maxQueries: Math.min(readPositiveInt(config, 'maxQueries', 3), MAX_QUERIES_CAP),
    maxResults: Math.min(readPositiveInt(config, 'maxResults', 8), 20),
    planMaxTokens: readPositiveInt(config, 'planMaxTokens', 512),
    planTimeoutMs: readPositiveInt(config, 'planTimeoutMs', 20000),
    searchTimeoutMs: readPositiveInt(config, 'searchTimeoutMs', 20000),
    debug: readBool(config, 'debug', false),
  })
}

/** 统一错误文案提取。 */
function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? message.slice(0, 500) : message
}
function isAbort(error) {
  return error !== undefined && error !== null && (error.name === 'AbortError' || error.code === 'WEB_ABORTED')
}
/** 把任意内部错误收敛成 web seam 认得的结构化错误。 */
function toWebError(error) {
  if (error instanceof WebError) return error
  if (isAbort(error)) return new WebError('web-search-session: search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError('web-search-session: ' + messageOf(error), 'WEB_PROVIDER_ERROR', { cause: error })
}
/** 组合取消信号与时 budget；任一不可用时退化为可用的那个。 */
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
  } catch {
    return undefined
  }
}
function anySignal(signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  return list[0]
}

/** 读当前会话路由：provider/model 来自最近一次 request/context 事件。 */
function sessionRoute(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.currentInitiator !== 'function') return undefined
  const session = agents.currentInitiator()?.session
  if (session === undefined || session === null) return undefined
  let context
  try {
    context = typeof session.requestContext === 'function' ? session.requestContext() : undefined
  } catch {
    context = undefined
  }
  const provider = typeof context?.provider === 'string' ? context.provider : ''
  const model = typeof context?.model === 'string' ? context.model : ''
  if (provider.length === 0 || model.length === 0) return undefined
  const sessionId = typeof session.id === 'string' && session.id.length > 0 ? session.id : undefined
  return { provider, model, sessionId }
}

/** 解析模型给出的检索词数组，任何异常形态都退化为空数组。 */
function parseTerms(text, limit) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  let body = text.trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/iu)
  if (fence !== null && fence[1] !== undefined) body = fence[1].trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start >= 0 && end > start) body = body.slice(start, end + 1)
  let values
  try {
    const parsed = JSON.parse(body)
    values = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    // 模型没按约定返回 JSON：返回空数组，由调用方退回原始问题；绝不把散文当检索词。
    return []
  }
  const terms = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const term = value.replace(/^[\s\-*\d.)"'\]]+/u, '').replace(/[\s"']+$/u, '').trim()
    if (term.length === 0 || term.length > 300) continue
    if (!terms.includes(term)) terms.push(term)
    if (terms.length >= limit) break
  }
  return terms
}

/** 用当前会话模型把问题改写成检索词；失败即降级为空数组（调用方回退原始问题）。 */
async function planQueries(ctx, settings, route, query, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') return []
  const budget = anySignal([signal, timeoutSignal(settings.planTimeoutMs)])
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Question: ' + query + '\n\nReturn at most ' + settings.maxQueries + ' web search queries as a JSON array.',
        },
      ],
    },
  ]
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system: PLAN_SYSTEM,
    maxTokens: settings.planMaxTokens,
    purpose: 'web-search',
    ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
    ...(budget === undefined ? {} : { signal: budget }),
  }
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) assembler.push(chunk)
    const text = assembler
      .blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    const terms = parseTerms(text, settings.maxQueries)
    if (settings.debug) ctx.logger?.info?.('web-search-session: planned terms ' + JSON.stringify(terms) + ' via ' + route.provider + '/' + route.model)
    return terms
  } catch (error) {
    ctx.logger?.warn?.(
      'web-search-session: query planning with ' + route.provider + '/' + route.model + ' failed (' + messageOf(error) + '); using the raw query',
    )
    return []
  }
}

/** 解析检索后端需要的密钥：先凭据服务，再进程环境变量。 */
async function resolveKey(ctx, settings) {
  const envName = settings.apiKeyEnv
  if (envName.length === 0) return ''
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(credentialRef(envName))
      const value = resolved === undefined || resolved === null ? undefined : resolved.value
      if (typeof value === 'string' && value.length > 0) return value
    } catch (error) {
      ctx.logger?.debug?.('web-search-session: credential "' + envName + '" unresolved: ' + messageOf(error))
    }
  }
  const ambient = process.env[envName]
  return typeof ambient === 'string' ? ambient : ''
}

/** 发一个 JSON 请求并把非 2xx / 不可解析的响应变成结构化错误。 */
async function requestJson(url, init, signal, label) {
  const response = await fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) })
  const text = await response.text()
  if (!response.ok) {
    const detail = text.replace(/\s+/gu, ' ').trim().slice(0, 200)
    throw new WebError(label + ' returned HTTP ' + response.status + (detail.length === 0 ? '' : ': ' + detail), 'WEB_PROVIDER_ERROR')
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new WebError(label + ' response exceeded ' + MAX_RESPONSE_CHARS + ' characters', 'WEB_PROVIDER_ERROR')
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new WebError(label + ' returned an unprocessable response body: ' + messageOf(error), 'WEB_PROVIDER_ERROR')
  }
}
/** 后端字段名差异统一：title / snippet / publishedAt。 */
function firstString(...values) {
  for (const value of values) if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return undefined
}
function normalizeSources(items, label) {
  const sources = []
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    const url = firstString(item.url, item.link, item.href)
    if (url === undefined) continue
    const title = firstString(item.title, item.name, item.heading)
    const snippet = firstString(item.content, item.description, item.snippet, item.text, item.summary)
    const publishedAt = firstString(item.published_date, item.page_age, item.publishedDate, item.age, item.date)
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet: snippet.length > MAX_SNIPPET_CHARS ? snippet.slice(0, MAX_SNIPPET_CHARS) : snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
    if (label === undefined) continue
  }
  return sources
}

async function searchTavily(settings, term, maxResults, key, signal) {
  const payload = {
    query: term,
    max_results: maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    ...(key.length === 0 ? {} : { api_key: key }),
  }
  const json = await requestJson(
    settings.endpoint + '/search',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(key.length === 0 ? {} : { authorization: 'Bearer ' + key }),
      },
      body: JSON.stringify(payload),
    },
    signal,
    'Tavily',
  )
  return normalizeSources(json?.results, 'tavily')
}
async function searchBrave(settings, term, maxResults, key, signal) {
  const url = settings.endpoint + '/res/v1/web/search?q=' + encodeURIComponent(term) + '&count=' + String(maxResults)
  const json = await requestJson(
    url,
    { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': key } },
    signal,
    'Brave',
  )
  return normalizeSources(json?.web?.results, 'brave')
}
async function searchSearxng(settings, term, maxResults, key, signal) {
  const url = settings.endpoint + '/search?q=' + encodeURIComponent(term) + '&format=json&safesearch=0'
  const json = await requestJson(url, { method: 'GET', headers: { accept: 'application/json' } }, signal, 'SearXNG')
  return normalizeSources(json?.results, 'searxng').slice(0, maxResults)
}
/** 按配置分发到具体后端。 */
async function searchBackend(settings, term, maxResults, key, signal) {
  switch (settings.backend) {
    case 'tavily':
      return await searchTavily(settings, term, maxResults, key, signal)
    case 'brave':
      return await searchBrave(settings, term, maxResults, key, signal)
    case 'searxng':
      return await searchSearxng(settings, term, maxResults, key, signal)
    default:
      throw new WebError('web-search-session: no retrieval backend is configured (backend="' + settings.backend + '")', 'WEB_PROVIDER_ERROR')
  }
}
/** 多查询并发检索、按 url 去重、截断到 maxResults。 */
async function retrieve(settings, terms, maxResults, key, signal) {
  if (settings.backend !== 'searxng' && settings.backend !== 'none' && key.length === 0) {
    throw new WebError(
      'web-search-session: backend "' + settings.backend + '" needs a credential; set ' + settings.apiKeyEnv + ' through the credentials service or the environment',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  const settled = await Promise.allSettled(terms.map((term) => searchBackend(settings, term, maxResults, key, signal)))
  const seen = new Set()
  const sources = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const source of result.value) {
      if (seen.has(source.url)) continue
      seen.add(source.url)
      sources.push(source)
      if (sources.length >= maxResults) break
    }
    if (sources.length >= maxResults) break
  }
  if (sources.length === 0) {
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
    throw new WebError('web-search-session: the retrieval backend returned no sources for ' + JSON.stringify(terms), 'WEB_PROVIDER_ERROR')
  }
  return sources
}

/** 从 seam 的提供方注册表里取官方提供方（非公开 API，仅作回退）。 */
function officialProvider(ctx, settings) {
  const registry = ctx.web === undefined ? undefined : ctx.web.searchProviders
  if (registry === undefined || registry === null || typeof registry.get !== 'function') return undefined
  const provider = registry.get(settings.officialProviderId)
  if (provider === undefined || provider === null) return undefined
  if (provider.id === settings.providerId) return undefined
  return provider
}
/** 委派官方提供方；取不到就抛结构化错误。 */
async function searchOfficial(ctx, settings, request, signal, reason) {
  const provider = officialProvider(ctx, settings)
  if (provider === undefined) {
    throw new WebError(
      'web-search-session: ' + reason + '; the official provider "' + settings.officialProviderId + '" is not registered for fallback',
      'WEB_PROVIDER_ERROR',
    )
  }
  ctx.logger?.info?.('web-search-session: delegating to "' + settings.officialProviderId + '" (' + reason + ')')
  return await provider.search(request, signal)
}

/** 一次搜索的完整流程。 */
async function runSearch(ctx, settings, request, signal) {
  if (signal?.aborted === true) throw new WebError('web-search-session: search aborted', 'WEB_ABORTED')
  const query = typeof request?.query === 'string' ? request.query.trim() : ''
  if (query.length === 0) throw new WebError('web-search-session: empty search query', 'WEB_PROVIDER_ERROR')
  const requested = request?.maxResults
  const maxResults = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 20) : settings.maxResults
  const route = sessionRoute(ctx)
  const budget = anySignal([signal, timeoutSignal(settings.searchTimeoutMs)])

  if (route === undefined && settings.noRoute === 'official') {
    return await searchOfficial(ctx, settings, request, signal, 'no session route')
  }
  if (route === undefined && settings.noRoute === 'error') {
    throw new WebError(
      'web-search-session: this session has no provider/model route yet (no request/context event); set noRoute: raw to search with the raw query',
      'WEB_PROVIDER_ERROR',
    )
  }
  let terms = [query]
  if (route !== undefined && settings.sessionPlanning) {
    const planned = await planQueries(ctx, settings, route, query, signal)
    if (planned.length > 0) terms = planned
  }
  // 兜底夹取：无论规划路径产出多少检索词，实际发出的平台调用次数都不超过 maxQueries。
  terms = terms.slice(0, settings.maxQueries)
  if (settings.backend === 'none') {
    if (settings.noRoute === 'official') return await searchOfficial(ctx, settings, request, signal, 'backend "none"')
    throw new WebError('web-search-session: backend "none" cannot retrieve sources; set backend to searxng, tavily or brave', 'WEB_PROVIDER_ERROR')
  }
  try {
    const key = await resolveKey(ctx, settings)
    const sources = await retrieve(settings, terms, maxResults, key, budget)
    if (settings.debug) ctx.logger?.info?.('web-search-session: ' + String(sources.length) + ' sources via ' + settings.backend + ' for ' + JSON.stringify(terms))
    return { sources, truncated: false }
  } catch (error) {
    if (isAbort(error)) throw toWebError(error)
    // 缺少凭据是确定性的配置错误：回退只会把真正的原因藏起来，所以直接抛出。
    const deterministic = error instanceof WebError && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
    if (settings.noRoute === 'official' && !deterministic) {
      ctx.logger?.warn?.('web-search-session: ' + settings.backend + ' retrieval failed (' + messageOf(error) + '); delegating to the official provider')
      try {
        return await searchOfficial(ctx, settings, request, signal, 'retrieval failed')
      } catch (fallbackError) {
        if (isAbort(fallbackError)) throw toWebError(fallbackError)
        throw new WebError(
          'web-search-session: retrieval failed (' + messageOf(error) + ') and the official fallback also failed (' + messageOf(fallbackError) + ')',
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }
    throw toWebError(error)
  }
}

/** 注册提供方。 */
export function apply(ctx, config) {
  const settings = settingsOf(config)
  if (!hasVolatileRefs()) {
    ctx.logger?.warn?.(
      'web-search-session: volatile 字段没有被装箱（解析到了旧版 @deepseek-ai/schemastery），保存设置后需重启 App 才生效；' +
        '请让插件解析到 DSH 运行时那份（>=3.18.3）',
    )
  }
  const provider = {
    id: settings.providerId,
    available() {
      const current = settingsOf(config)
      if (current.backend !== 'none') return true
      return current.noRoute === 'official'
    },
    async search(request, signal) {
      return await runSearch(ctx, settingsOf(config), request, signal)
    },
  }
  ctx.web.registerSearchProvider(provider)
  ctx.logger?.info?.('web-search-session: registered search provider "' + provider.id + '"')
}
