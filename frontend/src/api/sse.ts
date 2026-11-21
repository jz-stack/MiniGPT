// ========== POST SSE 客户端：fetch + ReadableStream 手写解析 ==========
// 原生 EventSource 不支持 POST + JSON body，流式问答需自行解析 text/event-stream

export interface SSESource {
  documentName: string
  chunkIndex: number
  score: number
  content: string
}

interface SSEHandlers {
  onSources?: (sources: SSESource[]) => void
  onDelta?: (delta: string) => void
  onDone?: (full: string) => void
  onError?: (message: string) => void
  /** 知识库检索失败、已降级为普通对话时触发 */
  onDegraded?: (reason: string) => void
}

interface SendMessagePayload {
  conversationId: number
  message: string
  docId?: number
}

/**
 * 解析单个 SSE 事件块。
 * 只去掉 data 行紧随其后的「一个」空格：按规范其余空白属于数据内容，
 * 原先用 trim() 会吃掉数据首尾空白（审查报告 P2-16）。
 * 同时忽略注释行（服务端心跳 `: ping`）。
 */
function parseEvent(raw: string): { event: string; data: any | null } {
  let event = 'message'
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  if (dataLines.length === 0) return { event, data: null }
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return { event, data: null }
  }
}

/**
 * 发起流式问答
 * @returns abort 函数，用于「停止生成」
 */
export async function streamChat(
  payload: SendMessagePayload,
  handlers: SSEHandlers
): Promise<() => void> {
  const controller = new AbortController()

  void (async () => {
    let receivedDone = false
    let full = ''

    try {
      const resp = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!resp.ok || !resp.body) {
        // 参数校验失败时后端返回 JSON，尽量取出可读文案，而不是只显示状态码
        let message = `请求失败：${resp.status}`
        try {
          const body = await resp.json()
          if (body?.message) message = body.message
        } catch {
          // 响应不是 JSON，保留默认文案
        }
        throw new Error(message)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以两个换行分隔
        const events = buffer.split('\n\n')
        buffer = events.pop() || '' // 最后一段可能不完整，留到下次

        for (const evt of events) {
          const { event, data } = parseEvent(evt)
          if (data === null) continue

          switch (event) {
            case 'sources':
              handlers.onSources?.(data as SSESource[])
              break
            case 'degraded':
              handlers.onDegraded?.(String(data.reason || '知识库检索失败'))
              break
            case 'delta': {
              const text = data.content
              if (typeof text === 'string' && text) {
                full += text
                handlers.onDelta?.(text)
              }
              break
            }
            case 'done':
              receivedDone = true
              handlers.onDone?.(data.content || full)
              return
            case 'error':
              throw new Error(data.message || '生成失败')
          }
        }
      }

      // 读到流末尾却没收到 done：说明连接被中途掐断，
      // 不能当成功处理，否则用户会以为答案是完整的（审查报告 P2-17）
      if (!receivedDone) throw new Error('连接意外中断，回答可能不完整')
      handlers.onDone?.(full)
    } catch (err: any) {
      if (err?.name === 'AbortError') return // 用户主动停止，不算错误
      handlers.onError?.(err?.message || '生成失败')
    }
  })()

  return () => controller.abort()
}
