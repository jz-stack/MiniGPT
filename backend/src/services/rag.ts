// ========== RAG Prompt 组装 ==========
import type { RetrievedChunk } from './vector.js'

/** 注入 Prompt 的上下文总字符预算，防止 Top-K 调大后撑爆模型上下文窗口 */
const MAX_CONTEXT_CHARS = 12_000
/** 单个片段的字符上限 */
const MAX_PER_SOURCE_CHARS = 2_000

/**
 * 用检索到的片段拼 System Prompt
 * 关键：要求模型「只依据片段作答，没有依据就说明」，降低幻觉
 *
 * 编号说明：片段编号固定使用数组下标 +1，与前端「参考来源」列表的顺序保持一致，
 * 即使某些片段因预算被截断，模型引用的 [n] 仍能对上前端展示的第 n 条来源。
 */
export function buildRagPrompt(sources: RetrievedChunk[]): string {
  if (sources.length === 0) return ''

  // 按片段数量均分预算（下限 200 字符），保证每条来源都进入 Prompt 且编号连续
  const perSource = Math.min(
    MAX_PER_SOURCE_CHARS,
    Math.max(200, Math.floor(MAX_CONTEXT_CHARS / sources.length))
  )

  const context = sources
    .map((s, i) => {
      const truncated =
        s.content.length > perSource ? `${s.content.slice(0, perSource)}……（已截断）` : s.content
      return `【片段${i + 1}】来源文档：《${s.documentName}》\n${truncated}`
    })
    .join('\n\n---\n\n')

  return `你是一个严谨的知识库问答助手。请严格依据下面提供的参考片段回答用户问题。

要求：
1. 只能使用参考片段中的信息，不要编造片段以外的内容。
2. 如果参考片段不足以回答问题，直接说明"根据现有知识库无法回答该问题"。
3. 回答时在相关语句末尾用 [1][2] 标注引用的片段编号。
4. 使用清晰的 Markdown 格式组织答案。

参考片段：
${context}`
}
