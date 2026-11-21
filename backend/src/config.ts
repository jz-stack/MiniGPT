// ========== 全局配置：环境变量 + 默认值 ==========
import dotenv from 'dotenv'

dotenv.config()

/**
 * 读取整数环境变量。
 * 注意：`Number('')` 等于 0 而不是 NaN，因此必须先显式把空串当作「未设置」，
 * 否则 .env 里写成 `CHUNK_SIZE=` 会把配置静默变成 0。
 */
function intEnv(raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
}

/** 逗号分隔列表，空项自动丢弃 */
function listEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

const corsOrigins = listEnv(process.env.CORS_ORIGIN)

export const env = {
  // 默认只监听回环地址：本服务无鉴权且可写入 API Key，不应暴露到局域网/公网。
  // 需要局域网访问时显式设置 HOST=0.0.0.0，并自行承担安全责任（见 README 安全边界）。
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: intEnv(process.env.PORT, 8000, 1),

  // 允许跨域访问本服务的来源白名单（写操作会据此校验 Origin）
  corsOrigins: corsOrigins.length
    ? corsOrigins
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],

  // 非空时，模型 baseUrl 的域名必须命中白名单（逗号分隔）
  allowedModelHosts: listEnv(process.env.ALLOWED_MODEL_HOSTS),

  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
  },
  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1',
    apiKey: process.env.EMBEDDING_API_KEY || '',
    model: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
  },
  rag: {
    chunkSize: intEnv(process.env.CHUNK_SIZE, 500, 1),
    chunkOverlap: intEnv(process.env.CHUNK_OVERLAP, 80, 0),
    topK: intEnv(process.env.TOP_K, 4, 1),
  },

  // 各类输入上限，避免单请求耗尽内存或撑爆模型上下文
  limits: {
    /** 单条提问最大字符数 */
    maxMessageChars: intEnv(process.env.MAX_MESSAGE_CHARS, 8000, 1),
    /** 单文件上传上限（同时受 multer 限制） */
    maxUploadBytes: 20 * 1024 * 1024,
    /** 解析纯文本上限，超过则拒绝，避免超长文档产生海量片段 */
    maxDocChars: intEnv(process.env.MAX_DOC_CHARS, 5_000_000, 1000),
    /** 同时处理的文档数上限（每个文档会在内存里持有文件与向量） */
    maxConcurrentParsing: intEnv(process.env.MAX_CONCURRENT_PARSING, 3, 1),
    /** 检索片段相似度阈值，低于该值不注入 Prompt */
    minScore: Number(process.env.MIN_SCORE || 0.3),
    /** Top-K 上限：超出后全库排序并撑爆模型上下文 */
    maxTopK: intEnv(process.env.MAX_TOP_K, 50, 1),
  },

  timeouts: {
    /** 向量化单次请求超时（毫秒） */
    embedMs: intEnv(process.env.EMBEDDING_TIMEOUT_MS, 30_000, 1000),
    /** 对话单次请求超时（毫秒），指首字节等待时间 */
    llmMs: intEnv(process.env.LLM_TIMEOUT_MS, 120_000, 1000),
  },
}
