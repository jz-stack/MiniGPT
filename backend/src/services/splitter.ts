// ========== 文本分块：滑动窗口 + 重叠 ==========

/** 单块字符数下限/上限，防止设置页或环境变量传入异常值 */
const MIN_CHUNK_SIZE = 1
const MAX_CHUNK_SIZE = 10_000

/**
 * 按「字符数」切分，相邻块保留重叠，避免语义被截断
 * @param text 原始文本
 * @param chunkSize 每块字符数（默认 500）
 * @param overlap   相邻块重叠字符数（默认 80）
 */
export function splitText(text: string, chunkSize = 500, overlap = 80): string[] {
  // 统一换行、去掉多余空白
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (!clean) return []

  // 参数钳制（审查报告 B1）：
  // 原实现用 start = end - overlap 前进，当 overlap >= chunkSize 时前进量 <= 0，
  // 循环条件 start < clean.length 恒成立 → 死循环并持续 push 片段，直到内存耗尽。
  // 这里把两个参数收敛到合法区间，保证每轮至少前进 1 个字符。
  const size = clampInt(chunkSize, 500, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
  const ov = clampInt(overlap, 80, 0, size - 1)

  const chunks: string[] = []
  let start = 0

  while (start < clean.length) {
    const end = Math.min(start + size, clean.length)
    chunks.push(clean.slice(start, end))

    if (end >= clean.length) break // 已到末尾
    start = end - ov // 回退一段，制造重叠；因 ov <= size-1，此处每轮至少前进 1 字符
  }

  return chunks
}

/**
 * 把任意输入收敛为 [min, max] 内的整数，非法值回退到 fallback。
 * 注意：回退值本身也必须参与收敛——例如 size=50、overlap 未传时 fallback=80，
 * 若不收敛就会得到 overlap > size，重新触发死循环。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  const base = Number.isFinite(n) ? n : fallback
  return Math.min(Math.max(base, min), max)
}
