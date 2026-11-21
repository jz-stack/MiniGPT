// ========== 错误类型与对外文案 ==========
// 目的：区分「可以安全展示给用户」的错误（未配置 Key、文件格式不支持等自述型错误）
// 与「内部实现细节」（上游地址、堆栈、SQL 细节），避免把内部信息透给前端。
// 对应审查报告：P2-11

/**
 * 可安全展示给调用方的错误。
 * 只有显式抛出的 PublicError 才会把 message 原样返回给前端。
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicError'
  }
}

/**
 * 取出可安全展示的文案。
 * 非 PublicError 一律返回兜底文案，真实原因由调用方写入服务端日志。
 */
export function toPublicMessage(err: unknown, fallback = '服务器内部错误'): string {
  if (err instanceof PublicError) return err.message
  return fallback
}
