// ========== LLM 流式对话：调用 OpenAI 兼容接口，逐 token 输出 ==========
import OpenAI, { APIUserAbortError } from 'openai'
import { getSetting } from '../db.js'
import { env } from '../config.js'
import { PublicError } from '../errors.js'

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 读取运行时配置（设置页可改），回退到 .env
 */
async function llmConfig() {
  const apiKey = (await getSetting('llmApiKey')) || env.llm.apiKey
  const baseUrl = (await getSetting('llmBaseUrl')) || env.llm.baseUrl
  const model = (await getSetting('llmModel')) || env.llm.model

  if (!apiKey) {
    throw new PublicError('未配置 LLM API Key，请先在「系统设置」中填写')
  }
  return { apiKey, baseUrl, model }
}

/**
 * 判断是否为「主动中止」导致的错误。
 * 客户端断开时会通过 AbortSignal 中止上游请求，这类错误不应报给用户。
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return true
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

/**
 * 流式聊天
 * @param messages 完整对话消息（含 system）
 * @param onDelta  每收到一个 token 片段回调
 * @param signal   可选，客户端断开时用它中止上游请求（审查报告 B3）
 * @returns 完整回答文本
 */
export async function streamChat(
  messages: Message[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { apiKey, baseUrl, model } = await llmConfig()
  const client = new OpenAI({ apiKey, baseURL: baseUrl })

  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      stream: true,
      temperature: 0.7,
    },
    // 显式设定超时（审查报告 M3）：不设时 SDK 默认 600000ms（10 分钟）。
    // maxRetries 保持 SDK 的 2 次：重试只发生在响应头阶段，此时尚未回调 onDelta，
    // 因此不会把已推送的 token 重复发给前端。
    { timeout: env.timeouts.llmMs, maxRetries: 2, signal: signal ?? undefined }
  )

  let full = ''
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content || ''
    if (delta) {
      full += delta
      onDelta(delta)
    }
  }
  return full
}
