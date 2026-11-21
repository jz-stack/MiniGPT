// ========== 文档路由：上传 / 列表 / 片段 / 删除 / 检索测试 ==========
import { Router } from 'express'
import multer from 'multer'
import { all, get, getSync, run, runSync, getSetting, transaction, insertChunksSync } from '../db.js'
import { env } from '../config.js'
import { parseDocument, fileExt, isSupportedExt } from '../services/parser.js'
import { splitText } from '../services/splitter.js'
import { embedTexts, embedQuery } from '../services/embedding.js'
import { searchSimilar, clampTopK } from '../services/vector.js'
import { PublicError, toPublicMessage } from '../errors.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.limits.maxUploadBytes, files: 1 },
})

// ---------- 处理并发闸门 ----------
// 每个文档在处理期间都会在内存中持有原文件缓冲、全文与向量，
// 不限并发会随上传数线性吃内存（审查报告 P2-6）
let parsingCount = 0

/** 路径参数必须是正整数，非法值直接 400，避免落到 SQL 层再报错 */
function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// 文档列表
router.get('/', async (_req, res) => {
  // chunkCount 统一取自 documents 列（单一数据源）：
  // 原先既写列、又用子查询实时统计，两处可能不一致（审查报告 P2-13）
  const docs = await all('SELECT * FROM documents ORDER BY id DESC')
  res.json({ code: 0, data: docs })
})

// 上传文档（异步解析 → 分块 → 向量化）
router.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ code: 1, message: '未收到文件' })

  const ext = fileExt(file.originalname)
  if (!isSupportedExt(ext)) {
    return res.status(400).json({ code: 1, message: `暂不支持的文件格式：.${ext}` })
  }

  if (parsingCount >= env.limits.maxConcurrentParsing) {
    return res.status(429).json({
      code: 1,
      message: `当前有 ${parsingCount} 个文档正在处理，请等待处理完成后再上传`,
    })
  }

  const { lastID } = await run(
    'INSERT INTO documents (name, fileType, status, chunkCount) VALUES (?, ?, ?, 0)',
    [file.originalname, ext, 'processing']
  )

  // 先响应，后台异步处理
  res.json({ code: 0, data: { id: lastID, name: file.originalname } })

  parsingCount++
  processDocument(lastID, file.originalname, file.buffer)
    .catch((err: unknown) => {
      console.error(`[documents] 文档 ${lastID} 处理失败:`, err)
      const message = toPublicMessage(err, '文档处理失败，请检查文件内容后重试')
      try {
        // 失败时把状态与残留片段一起清理，保证失败文档不会污染检索结果（审查报告 M2）
        transaction(() => {
          runSync('DELETE FROM chunks WHERE documentId = ?', [lastID])
          runSync(
            'UPDATE documents SET status = ?, chunkCount = 0, errorMsg = ? WHERE id = ?',
            ['failed', message, lastID]
          )
        })
      } catch (writeErr) {
        console.error(`[documents] 文档 ${lastID} 失败状态写入异常:`, writeErr)
      }
    })
    .finally(() => {
      parsingCount--
    })
})

// 文档处理核心流程：解析 → 分块 → 向量化 → 入库
async function processDocument(docId: number, fileName: string, buffer: Buffer) {
  // 1. 解析文本（内含文件签名与体积校验）
  const text = await parseDocument(fileName, buffer)
  if (!text.trim()) throw new PublicError('文档内容为空，可能是扫描件或解析失败')

  // 2. 分块（splitText 内部对参数做钳制，非法组合不会再造成死循环）
  const chunkSize = Number(await getSetting('chunkSize')) || env.rag.chunkSize
  const chunkOverlap = Number(await getSetting('chunkOverlap')) || env.rag.chunkOverlap
  const chunks = splitText(text, chunkSize, chunkOverlap)
  if (chunks.length === 0) throw new PublicError('分块结果为空')

  // 3. 向量化
  const embeddings = await embedTexts(chunks)

  // 4. 批量写入片段 + 更新状态，放在同一事务里，避免出现「有片段但状态不是 ready」的中间态
  transaction(() => {
    insertChunksSync(docId, chunks, embeddings) // 嵌套调用，复用外层事务
    runSync(
      'UPDATE documents SET status = ?, chunkCount = ?, errorMsg = NULL WHERE id = ?',
      ['ready', chunks.length, docId]
    )
  })
}

// 检索测试：输入问题，返回最相关片段
router.post('/search', async (req, res) => {
  try {
    const { query, docId } = (req.body ?? {}) as { query?: string; docId?: number }
    const text = typeof query === 'string' ? query.trim() : ''
    if (!text) return res.status(400).json({ code: 1, message: 'query 不能为空' })
    if (text.length > env.limits.maxMessageChars) {
      return res
        .status(400)
        .json({ code: 1, message: `query 过长（上限 ${env.limits.maxMessageChars} 字符）` })
    }

    let targetDocId: number | undefined
    if (docId !== undefined && docId !== null) {
      targetDocId = Number(docId)
      if (!Number.isInteger(targetDocId) || targetDocId <= 0) {
        return res.status(400).json({ code: 1, message: 'docId 不合法' })
      }
      const doc = await get<{ id: number }>('SELECT id FROM documents WHERE id = ?', [targetDocId])
      if (!doc) return res.status(404).json({ code: 1, message: '指定文档不存在' })
    }

    const topK = clampTopK(Number(await getSetting('topK')) || env.rag.topK)
    const qVec = await embedQuery(text)
    const results = await searchSimilar(qVec, topK, targetDocId)

    res.json({ code: 0, data: results })
  } catch (err) {
    console.error('[documents] 检索测试失败:', err)
    res.status(500).json({ code: 1, message: toPublicMessage(err, '检索失败，请稍后重试') })
  }
})

// 查看文档的片段
router.get('/:id/chunks', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return res.status(400).json({ code: 1, message: 'id 不合法' })

  const doc = await get<{ id: number }>('SELECT id FROM documents WHERE id = ?', [id])
  if (!doc) return res.status(404).json({ code: 1, message: '文档不存在' })

  const chunks = await all(
    'SELECT id, chunkIndex, substr(content, 1, 200) AS preview FROM chunks WHERE documentId = ? ORDER BY chunkIndex',
    [id]
  )
  res.json({ code: 0, data: chunks })
})

// 删除文档（级联删除片段）
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return res.status(400).json({ code: 1, message: 'id 不合法' })

  // 外键已开启级联删除，这里仍在同一事务内显式删除片段，语义更明确且不依赖 PRAGMA
  const changes = transaction(() => {
    const doc = getSync<{ id: number }>('SELECT id FROM documents WHERE id = ?', [id])
    if (!doc) return 0
    runSync('DELETE FROM chunks WHERE documentId = ?', [id])
    return runSync('DELETE FROM documents WHERE id = ?', [id]).changes
  })

  if (changes === 0) {
    // 原先对不存在的 id 也返回成功，前端无法区分「删掉了」和「本来就没有」（审查报告 P2-12）
    return res.status(404).json({ code: 1, message: '文档不存在或已被删除' })
  }
  res.json({ code: 0 })
})

export default router
