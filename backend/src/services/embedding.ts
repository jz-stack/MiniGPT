// ========== 向量服务：把文本转成 Embedding 向量 ==========
import OpenAI from 'openai'
import { getSetting } from '../db.js'
import { env } from '../config.js'
import { PublicError } from '../errors.js'

/**
 * 读取运行时配置（设置页可改），回退到 .env
 */
async function embeddingConfig() {
  const apiKey = (await getSetting('embeddingApiKey')) || env.embedding.apiKey
  const baseUrl = (await getSetting('embeddingBaseUrl')) || env.embedding.baseUrl
  const model = (await getSetting('embeddingModel')) || env.embedding.model

  if (!apiKey) {
    throw new PublicError('未配置 Embedding API Key，请先在「系统设置」中填写')
  }
  return { apiKey, baseUrl, model }
}

const batchSize = 16 // 分批调用，避免单次请求文本过多

/**
 * 批量生成向量
 * @param texts 文本数组
 * @param signal 可选，用于在客户端断开时中止请求
 * @returns 与 texts 等长的向量数组
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return []

  const { apiKey, baseUrl, model } = await embeddingConfig()
  const client = new OpenAI({ apiKey, baseURL: baseUrl })

  const result: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const resp = await client.embeddings.create(
      { model, input: batch },
      // 显式设定超时与重试次数（审查报告 M3）：
      // SDK 默认超时为 600000ms（10 分钟），会把文档处理长时间挂住；
      // 重试仍交给 SDK，它内部即是指数退避。
      { timeout: env.timeouts.embedMs, maxRetries: 2, signal: signal ?? undefined }
    )
    // 按 index 排序，保证顺序稳定（不改动 SDK 返回的数组本身）
    const sorted = [...resp.data].sort((a, b) => a.index - b.index)
    for (const item of sorted) result.push(item.embedding)
  }

  // 结果数量必须与输入等长，否则后续 insertChunksSync 的索引会对不上
  if (result.length !== texts.length) {
    throw new Error(
      `向量化返回数量异常（期望 ${texts.length} 条，实际 ${result.length} 条）`
    )
  }

  return result
}

/**
 * 单条文本向量化（用于检索问题）
 */
export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  const [vec] = await embedTexts([text], signal)
  if (!vec) {
    throw new Error('向量化结果为空')
  }
  return vec
}
