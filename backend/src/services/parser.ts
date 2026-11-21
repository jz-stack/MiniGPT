// ========== 文档解析：文件签名校验 + 按扩展名提取纯文本 ==========
import mammoth from 'mammoth'
import { createRequire } from 'node:module'
import { env } from '../config.js'
import { PublicError } from '../errors.js'

// pdf-parse 是 CommonJS 包，用 createRequire 引入，规避 ESM 兼容问题
const require = createRequire(import.meta.url)

// 直接引用 lib 入口，避免默认入口去读取测试 PDF 文件
const pdfParse = require('pdf-parse/lib/pdf-parse.js')

export const SUPPORTED_EXTS = ['txt', 'md', 'pdf', 'docx'] as const
export type SupportedExt = (typeof SUPPORTED_EXTS)[number]

/** 取扩展名（小写，不含点） */
export function fileExt(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || ''
}

export function isSupportedExt(ext: string): ext is SupportedExt {
  return (SUPPORTED_EXTS as readonly string[]).includes(ext)
}

/**
 * 文件头校验：只按扩展名挑解析器会让伪装文件（例如把可执行文件改名成 .docx）
 * 进入解析链路。这里用文件签名交叉校验，扩展名与内容不符直接拒绝。
 * 对应审查报告：P2-5
 */
function assertSignature(ext: SupportedExt, buffer: Buffer): void {
  switch (ext) {
    case 'pdf':
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new PublicError('文件内容不是有效的 PDF（文件头校验未通过）')
      }
      break
    case 'docx':
      // docx 是 zip 容器，文件头应为 PK\x03\x04
      if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw new PublicError('文件内容不是有效的 DOCX（文件头校验未通过）')
      }
      break
    case 'txt':
    case 'md':
      // 纯文本不应出现 NUL 字节，前 4KB 内出现即判定为二进制文件
      if (buffer.subarray(0, 4096).includes(0x00)) {
        throw new PublicError('文件内容不是纯文本（检测到二进制内容）')
      }
      break
  }
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/**
 * 解析上传文件，返回纯文本
 * 支持：txt / md / pdf / docx
 */
export async function parseDocument(fileName: string, buffer: Buffer): Promise<string> {
  const ext = fileExt(fileName)
  if (!isSupportedExt(ext)) {
    throw new PublicError(
      `暂不支持的文件格式：.${ext}（支持 ${SUPPORTED_EXTS.join(' / ')}）`
    )
  }

  assertSignature(ext, buffer)

  let text: string
  switch (ext) {
    case 'txt':
    case 'md':
      text = stripBom(buffer.toString('utf-8'))
      break

    case 'pdf': {
      const data = await pdfParse(buffer)
      text = data.text || ''
      break
    }

    case 'docx': {
      const result = await mammoth.extractRawText({ buffer })
      text = result.value || ''
      break
    }

    default:
      throw new PublicError(`暂不支持的文件格式：.${ext}`)
  }

  // 超长文档会产生海量片段并占用大量内存/磁盘，这里显式拒绝而不是硬撑
  if (text.length > env.limits.maxDocChars) {
    throw new PublicError(
      `文档内容过长（约 ${text.length} 字符，上限 ${env.limits.maxDocChars}），请拆分后分批上传`
    )
  }

  return text
}
