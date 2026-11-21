// ========== 后端入口：Express 服务 ==========
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { env } from './config.js'
import { initDB, closeDB } from './db.js'
import documentRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import configRoutes from './routes/config.js'

const app = express()

// CORS：只放行白名单来源（审查报告 B4）。
// 原先是 app.use(cors())，默认 origin:'*'，任意网页都能通过预检读写本机接口；
// 又因 /api/config 可改写 llmBaseUrl，最终会把真实 API Key 发往攻击者地址。
app.use(
  cors({
    origin: env.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: false,
    maxAge: 600,
  })
)

// 请求体上限收紧到 1MB：JSON 接口只接收短文本，上传走 multipart（审查报告 P2-6、P2-19）
app.use(express.json({ limit: '1mb' }))

// 写操作来源校验（纵深防御，审查报告 B4）：
// 跨域写请求的预检已被 CORS 白名单挡住，这里再显式校验一次 Origin，
// 使非白名单来源的写操作即使绕过预检也无法落库。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const origin = req.headers.origin
  // 无 Origin 头的请求（curl、同源部署、服务间调用）不受跨域限制，正常放行
  if (!origin || env.corsOrigins.includes(origin)) return next()
  res.status(403).json({ code: 1, message: '来源不被信任，已拒绝该写操作' })
})

// 路由
app.use('/api/documents', documentRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/config', configRoutes)

// 健康检查
app.get('/api/health', (_req, res) => res.json({ code: 0, data: 'ok' }))

// 未匹配的接口统一 404，避免落到错误处理中间件里被当成 500
app.use((_req, res) => {
  res.status(404).json({ code: 1, message: '接口不存在' })
})

// 全局错误处理
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  // multer 的大小限制错误给出可操作的提示
  if (err?.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(env.limits.maxUploadBytes / 1024 / 1024)
    console.warn('[server] 上传文件超过限制:', mb, 'MB')
    if (!res.headersSent) res.status(413).json({ code: 1, message: `文件超过 ${mb}MB 限制` })
    return
  }

  console.error('[server error]', err)

  // SSE 等已发出响应头的场景，再写 JSON body 会触发 ERR_HTTP_HEADERS_SENT（审查报告 P2-9）
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  // 对外统一文案，内部细节只进日志（审查报告 P2-11）
  res.status(500).json({ code: 1, message: '服务器内部错误' })
})

let server: ReturnType<typeof app.listen> | undefined

initDB()
  .then(() => {
    // 默认只监听回环地址：本服务无鉴权且可写入 API Key（审查报告 B4）
    server = app.listen(env.port, env.host, () => {
      console.log(`\n🚀 MiniGPT-KB 后端已启动: http://${env.host}:${env.port}`)
      console.log(`🩺 健康检查: http://${env.host}:${env.port}/api/health\n`)
      if (env.host !== '127.0.0.1' && env.host !== 'localhost' && env.host !== '::1') {
        console.warn('⚠️  当前监听非回环地址，而本服务不含鉴权，请确认所处网络环境可信')
      }
    })
  })
  .catch((err: unknown) => {
    console.error('[server] 数据库初始化失败，进程退出:', err)
    process.exit(1)
  })

// ---------- 优雅退出（审查报告 P2-10）----------
let shuttingDown = false
let closed = false

function releaseAndExit(code: number) {
  if (closed) return
  closed = true
  closeDB()
  process.exit(code)
}

function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n收到 ${signal}，正在停止服务...`)
  if (server) server.close(() => releaseAndExit(0))
  else releaseAndExit(0)
  // 兜底：连接迟迟不释放时强制退出
  setTimeout(() => releaseAndExit(0), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[server] 未处理的 Promise 拒绝:', reason)
})

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  // 客户端断开后继续写入已销毁的流属于可预期的良性错误，记录后继续服务
  const benign = ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']
  if (err?.code && benign.includes(err.code)) {
    console.warn('[server] 忽略已断开连接的写入错误:', err.code)
    return
  }
  console.error('[server] 未捕获异常，进程退出:', err)
  shutdown('uncaughtException')
})
