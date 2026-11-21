// ========== 配置路由：读取/保存运行时配置（设置页）==========
import { Router } from 'express'
import { getSettings, setSetting, deleteSetting } from '../db.js'
import { env } from '../config.js'

const router = Router()

// 可配置项：key 对应 settings 表，value 回退到 env
const KEYS = [
  'llmBaseUrl',
  'llmApiKey',
  'llmModel',
  'embeddingBaseUrl',
  'embeddingApiKey',
  'embeddingModel',
  'chunkSize',
  'chunkOverlap',
  'topK',
] as const

type ConfigKey = (typeof KEYS)[number]

// 敏感字段显式枚举，不再依赖 key.includes('ApiKey') 这种命名巧合（审查报告 P2-18）
const SENSITIVE_KEYS = new Set<ConfigKey>(['llmApiKey', 'embeddingApiKey'])

/** 脱敏占位符：GET 返回它，POST 收到它视为「未修改」 */
const MASK = '••••••••'

const MAX_URL_LEN = 512
const MAX_MODEL_LEN = 128
const MAX_KEY_LEN = 512

/** 数值字段的取值范围（写入时强制校验） */
const NUMERIC_RANGES: Partial<Record<ConfigKey, { min: number; max: number }>> = {
  chunkSize: { min: 1, max: 10_000 },
  chunkOverlap: { min: 0, max: 9_999 },
  topK: { min: 1, max: env.limits.maxTopK },
}

function envDefaults(): Record<ConfigKey, string> {
  return {
    llmBaseUrl: env.llm.baseUrl,
    llmApiKey: env.llm.apiKey,
    llmModel: env.llm.model,
    embeddingBaseUrl: env.embedding.baseUrl,
    embeddingApiKey: env.embedding.apiKey,
    embeddingModel: env.embedding.model,
    chunkSize: String(env.rag.chunkSize),
    chunkOverlap: String(env.rag.chunkOverlap),
    topK: String(env.rag.topK),
  }
}

/** 校验单个配置项，返回错误文案（null 表示通过） */
function validateValue(key: ConfigKey, val: string): string | null {
  if (SENSITIVE_KEYS.has(key)) {
    return val.length > MAX_KEY_LEN ? `${key} 过长（上限 ${MAX_KEY_LEN} 字符）` : null
  }

  if (key === 'llmBaseUrl' || key === 'embeddingBaseUrl') {
    if (val.length > MAX_URL_LEN) return `${key} 过长（上限 ${MAX_URL_LEN} 字符）`
    let url: URL
    try {
      url = new URL(val)
    } catch {
      return `${key} 不是合法的 URL`
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `${key} 仅支持 http / https 协议`
    }
    // 白名单非空时强制命中：baseUrl 一旦被改写到任意地址，apiKey 就会被发往该地址（审查报告 B4）
    if (env.allowedModelHosts.length && !env.allowedModelHosts.includes(url.host)) {
      return `${key} 的域名 ${url.host} 不在 ALLOWED_MODEL_HOSTS 白名单内`
    }
    return null
  }

  if (key === 'llmModel' || key === 'embeddingModel') {
    if (val.length > MAX_MODEL_LEN) return `${key} 过长（上限 ${MAX_MODEL_LEN} 字符）`
    if (/\s/.test(val)) return `${key} 不能包含空白字符`
    return null
  }

  const range = NUMERIC_RANGES[key]
  if (range) {
    const n = Number(val)
    if (!Number.isInteger(n)) return `${key} 必须是整数`
    if (n < range.min || n > range.max) return `${key} 必须在 ${range.min} ~ ${range.max} 之间`
    return null
  }

  return null
}

// 读取配置（apiKey 脱敏返回）
router.get('/', async (_req, res) => {
  // 一次查询取回全部配置，避免 9 次串行往返（审查报告 P2-3）
  const stored = await getSettings(KEYS)
  const defaults = envDefaults()

  const result: Record<string, string> = {}
  for (const key of KEYS) {
    const val = stored[key] ?? defaults[key]
    result[key] = SENSITIVE_KEYS.has(key) ? (val ? MASK : '') : val
  }
  res.json({ code: 0, data: result })
})

// 保存配置
// 约定：字段缺省 / null / 掩码值 = 不修改；空串 = 清空该项并回退到 .env（审查报告 P2-2）
router.post('/', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>

  // 先整体校验、再统一落库：避免写到一半失败，留下互相矛盾的配置组合
  const stored = await getSettings(KEYS)
  const defaults = envDefaults()
  const pending = new Map<ConfigKey, string | null>() // null 表示删除该项

  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    const raw = body[key]
    if (raw === null || raw === undefined) continue

    const val = String(raw).trim()
    // 掩码值一律视为「未修改」：前端不会提交它，这里兼容旧客户端
    if (val === MASK) continue

    if (val === '') {
      pending.set(key, null)
      continue
    }
    const error = validateValue(key, val)
    if (error) return res.status(400).json({ code: 1, message: error })
    pending.set(key, val)
  }

  // 跨字段校验：重叠必须小于分块大小，这是分块函数的前置约束（对应审查报告 B1 的配置侧防线）
  const effective = (key: ConfigKey): string => {
    const p = pending.get(key)
    if (p === undefined) return stored[key] ?? defaults[key]
    return p === null ? defaults[key] : p
  }
  const size = Number(effective('chunkSize'))
  const overlap = Number(effective('chunkOverlap'))
  if (Number.isFinite(size) && Number.isFinite(overlap) && overlap >= size) {
    return res
      .status(400)
      .json({ code: 1, message: `分块重叠（${overlap}）必须小于分块大小（${size}）` })
  }

  for (const [key, val] of pending) {
    if (val === null) await deleteSetting(key)
    else await setSetting(key, val)
  }
  res.json({ code: 0 })
})

export default router
