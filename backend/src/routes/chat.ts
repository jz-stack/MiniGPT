// ========== 对话路由：会话/消息管理 + RAG 流式问答（SSE）==========
import { Router } from 'express'
import { all, get, run, runSync, getSetting, transaction } from '../db.js'
import { env } from '../config.js'
import { embedQuery } from '../services/embedding.js'
import { searchSimilar, clampTopK } from '../services/vector.js'
import { buildRagPrompt } from '../services/rag.js'
import { streamChat, isAbortError } from '../services/llm.js'
import { toPublicMessage } from '../errors.js'

const router = Router()

/** SSE 心跳间隔：长时间检索/生成时防止中间层判定连接空闲而断开 */
const HEARTBEAT_MS = 15_000

/**
 * 会话级串行队列。
 * 同一会话的并发 /send（双击、多标签页）会依次执行，
 * 避免「插入用户消息」与「读取历史」交叉导致上下文互相污染（审查报告 M6）。
 */
const conversationQueues = new Map<number, Promise<void>>()

function enqueueConversation<T>(conversationId: number, task: () => Promise<T>): Promise<T> {
  const tail = conversationQueues.get(conversationId) ?? Promise.resolve()
  // 前一个任务无论成功或失败，都不阻断后一个
  const current = tail.then(task, task)
  const guard: Promise<void> = current.then(
    () => undefined,
    () => undefined
  )
  conversationQueues.set(conversationId, guard)
  guard.then(() => {
    // 队列跑完才清理，避免 Map 无界增长
    if (conversationQueues.get(conversationId) === guard) conversationQueues.delete(conversationId)
  })
  return current
}

/** 路径参数必须是正整数 */
function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// 会话列表
router.get('/conversations', async (_req, res) => {
  const convs = await all('SELECT * FROM conversations ORDER BY id DESC')
  res.json({ code: 0, data: convs })
})

// 新建会话
router.post('/conversations', async (_req, res) => {
  const { lastID } = await run('INSERT INTO conversations DEFAULT VALUES')
  res.json({ code: 0, data: { id: lastID, title: '新对话' } })
})

// 获取某会话的消息
router.get('/conversations/:id/messages', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return res.status(400).json({ code: 1, message: 'id 不合法' })

  const conv = await get<{ id: number }>('SELECT id FROM conversations WHERE id = ?', [id])
  if (!conv) return res.status(404).json({ code: 1, message: '会话不存在' })

  const messages = await all(
    'SELECT id, role, content, createdAt FROM messages WHERE conversationId = ? ORDER BY id',
    [id]
  )
  res.json({ code: 0, data: messages })
})

// 删除会话（级联删消息）
router.delete('/conversations/:id', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return res.status(400).json({ code: 1, message: 'id 不合法' })

  const changes = transaction(() => {
    runSync('DELETE FROM messages WHERE conversationId = ?', [id])
    return runSync('DELETE FROM conversations WHERE id = ?', [id]).changes
  })

  if (changes === 0) {
    return res.status(404).json({ code: 1, message: '会话不存在或已被删除' })
  }
  conversationQueues.delete(id)
  res.json({ code: 0 })
})

// ⭐ 流式问答：POST + SSE
router.post('/send', async (req, res) => {
  const { conversationId, message, docId } = (req.body ?? {}) as {
    conversationId?: number
    message?: string
    docId?: number
  }

  // ---- 入参校验（审查报告 M7）----
  // 原先不校验 conversationId，undefined 绑定到 SQLite 参数会抛
  // TypeError: Provided value cannot be bound to SQLite parameter 1，
  // 此时 SSE 头已发出，只能以 200 + error 事件收场，调用方拿到的是 500 语义。
  const convId = Number(conversationId)
  if (!Number.isInteger(convId) || convId <= 0) {
    return res.status(400).json({ code: 1, message: 'conversationId 不合法' })
  }
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return res.status(400).json({ code: 1, message: 'message 不能为空' })
  if (text.length > env.limits.maxMessageChars) {
    return res
      .status(400)
      .json({ code: 1, message: `message 过长（上限 ${env.limits.maxMessageChars} 字符）` })
  }

  const conv = await get<{ id: number }>('SELECT id FROM conversations WHERE id = ?', [convId])
  if (!conv) return res.status(404).json({ code: 1, message: '会话不存在' })

  let targetDocId: number | undefined
  if (docId !== undefined && docId !== null) {
    targetDocId = Number(docId)
    if (!Number.isInteger(targetDocId) || targetDocId <= 0) {
      return res.status(400).json({ code: 1, message: 'docId 不合法' })
    }
    const doc = await get<{ id: number; status: string }>(
      'SELECT id, status FROM documents WHERE id = ?',
      [targetDocId]
    )
    if (!doc) return res.status(404).json({ code: 1, message: '指定文档不存在' })
    if (doc.status !== 'ready') {
      return res.status(409).json({ code: 1, message: '指定文档尚未处理完成，暂不能用作检索范围' })
    }
  }

  // ---- SSE 响应头 ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // 关闭反向代理缓冲：否则 nginx 之类会攒够一批才下发，表现为「看不到逐字输出」
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  // 客户端断开时中止上游请求（审查报告 B3）。
  // 注意：不能用 req 的 'close' —— 实测它在请求体读完时（正常请求也会）立即触发；
  // res 的 'close' 配合 writableFinished 才能区分「正常结束」与「客户端提前断开」。
  const controller = new AbortController()
  let clientGone = false
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true
      controller.abort()
    }
  })

  try {
    const answer = await enqueueConversation(convId, () =>
      handleSend({ convId, text, docId: targetDocId, send, signal: controller.signal })
    )
    if (!clientGone) send('done', { content: answer })
  } catch (err) {
    console.error(`[chat] 会话 ${convId} 生成失败:`, err)
    if (isAbortError(err)) {
      // 主动停止：部分答案已由 handleSend 落库，这里无需再报错
      if (!clientGone) send('done', { content: '' })
    } else {
      send('error', { message: toPublicMessage(err, '生成失败，请稍后重试') })
    }
  } finally {
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  }
})

/**
 * 单轮问答的实际流程。
 * 返回值是本次生成的完整回答（可能为空），调用方负责下发 done。
 */
async function handleSend(args: {
  convId: number
  text: string
  docId?: number
  send: (event: string, data: unknown) => void
  signal: AbortSignal
}): Promise<string> {
  const { convId, text, docId, send, signal } = args

  // 1. 存用户消息
  runSync('INSERT INTO messages (conversationId, role, content) VALUES (?, ?, ?)', [
    convId,
    'user',
    text,
  ])

  // 2. RAG 检索：失败不阻塞问答，但必须显式告知前端，不能静默降级（审查报告 M4）
  let sources: Awaited<ReturnType<typeof searchSimilar>> = []
  let degraded: string | null = null
  try {
    const topK = clampTopK(Number(await getSetting('topK')) || env.rag.topK)
    const qVec = await embedQuery(text, signal)
    sources = (await searchSimilar(qVec, topK, docId)).filter(s => s.score >= env.limits.minScore)
  } catch (err) {
    if (isAbortError(err)) throw err
    console.error('[chat] 知识库检索失败，已降级为普通对话:', err)
    degraded = toPublicMessage(err, '知识库检索失败')
  }

  if (degraded) send('degraded', { reason: degraded })

  // 下发引用来源
  send(
    'sources',
    sources.map(s => ({
      documentName: s.documentName,
      chunkIndex: s.chunkIndex,
      score: Number(s.score.toFixed(4)),
      content: s.content.slice(0, 150),
    }))
  )

  // 3. 组装消息（system + 最近 10 轮历史 + 当前问题）
  const history = await all<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE conversationId = ? ORDER BY id DESC LIMIT 20`,
    [convId]
  )
  history.reverse()

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    {
      role: 'system',
      content:
        sources.length > 0
          ? buildRagPrompt(sources)
          : '你是一个有帮助的 AI 助手，请用中文回答。',
    },
  ]
  for (const h of history) {
    // 只接受合法角色，避免库中出现异常 role 时污染上游请求
    if (h.role !== 'user' && h.role !== 'assistant') continue
    messages.push({ role: h.role, content: h.content })
  }

  // 4. 流式生成
  let answer = ''
  let aborted = false
  let failure: unknown = null
  try {
    answer = await streamChat(
      messages,
      delta => {
        answer += delta
        send('delta', { content: delta })
      },
      signal
    )
  } catch (err) {
    if (isAbortError(err)) aborted = true
    else failure = err
  }

  // 5. 无论正常结束、被中止还是失败，都写入助手消息（审查报告 B3）：
  // 原先只在正常结束时落库，中途停止会留下「有提问、无回答」的孤立消息。
  const persisted = aborted
    ? answer
      ? `${answer}\n\n（已停止生成）`
      : '（已停止生成）'
    : failure
      ? answer
        ? `${answer}\n\n（生成失败）`
        : '（生成失败）'
      : answer

  runSync('INSERT INTO messages (conversationId, role, content) VALUES (?, ?, ?)', [
    convId,
    'assistant',
    persisted,
  ])

  if (failure) throw failure
  return answer
}

export default router
