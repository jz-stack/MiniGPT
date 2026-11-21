// ========== 向量检索：SQLite 存向量，内存中算余弦相似度 ==========
import { all } from '../db.js'
import { env } from '../config.js'

interface ChunkRow {
  id: number
  documentId: number
  chunkIndex: number
  content: string
  embedding: string
  documentName: string
}

/**
 * 余弦相似度：两向量越接近，分数越高（-1 ~ 1）。
 * 维度不一致时两者本就不可比（例如中途更换了 Embedding 模型），
 * 此时返回 0 —— 低于检索阈值，等价于不参与结果，而不是给出一个看似有效的分数。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface RetrievedChunk {
  chunkId: number
  documentId: number
  documentName: string
  chunkIndex: number
  content: string
  score: number
}

/** 收敛 Top-K，防止设置页传入极端值导致全库排序（审查报告 P2-4） */
export function clampTopK(topK: unknown): number {
  const n = Math.floor(Number(topK))
  if (!Number.isFinite(n)) return env.rag.topK
  return Math.min(Math.max(n, 1), env.limits.maxTopK)
}

// 只检索状态为 ready 的文档：处理中/失败的文档片段不应进入问答上下文。
// 关联 documents 同时取回文档名，省掉一次单独的名称映射查询。对应审查报告 M2。
const SELECT_READY_CHUNKS = `
  SELECT c.id, c.documentId, c.chunkIndex, c.content, c.embedding,
         d.name AS documentName
    FROM chunks c
    JOIN documents d ON d.id = c.documentId
   WHERE c.embedding IS NOT NULL
     AND d.status = 'ready'
`

/**
 * 语义检索：查询向量 vs 全库片段向量，取 Top-K
 * @param docId 可选，限定某个文档；不传则检索全部
 */
export async function searchSimilar(
  queryVec: number[],
  topK: number,
  docId?: number
): Promise<RetrievedChunk[]> {
  if (!Array.isArray(queryVec) || queryVec.length === 0) return []

  const k = clampTopK(topK)
  const rows = docId
    ? await all<ChunkRow>(`${SELECT_READY_CHUNKS} AND c.documentId = ?`, [docId])
    : await all<ChunkRow>(SELECT_READY_CHUNKS)

  const scored = rows.map(row => {
    const vec = parseEmbedding(row.embedding)
    return {
      chunkId: row.id,
      documentId: row.documentId,
      documentName: row.documentName || '未知文档',
      chunkIndex: row.chunkIndex,
      content: row.content,
      score: cosineSimilarity(queryVec, vec),
    }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/** 解析存库的向量字符串；损坏数据按空向量处理（相似度 0，自然被过滤） */
function parseEmbedding(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
