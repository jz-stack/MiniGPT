// 接口层回归测试：参数校验、状态码语义、CORS 白名单、消息成对性、上传拒绝路径。
// 对应审查报告 B3 / B4 / M4 / M7 / P2-5 / P2-7 / P2-11 / P2-12。
// 使用独立 DATA_DIR 与独立端口，不触碰开发库 backend/data。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../.test-data/api')
fs.rmSync(DATA_DIR, { recursive: true, force: true })

const PORT = '8097'
process.env.DATA_DIR = DATA_DIR
process.env.PORT = PORT
process.env.HOST = '127.0.0.1'
// 固定为空，保证测试不依赖也不触发真实模型调用
process.env.LLM_API_KEY = ''
process.env.EMBEDDING_API_KEY = ''
delete process.env.CORS_ORIGIN

const BASE = `http://127.0.0.1:${PORT}`
const ALLOWED_ORIGIN = 'http://localhost:3000'

let failed = 0
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log('  ✅', msg)
  else { failed++; console.log('  ❌', msg) }
}

await import('../src/index.js')
const { runSync, getSync } = await import('../src/db.js')

/** 读取单行且断言存在，便于测试里直接取字段 */
const getOne = <T,>(sql: string, params: any[] = []): T => getSync<T>(sql, params) as T

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* 未就绪 */ }
  await new Promise(r => setTimeout(r, 100))
}

const json = (p: string) => fetch(`${BASE}${p}`)
const postJson = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

console.log('\n[1] 健康检查与未匹配路由')
ok((await json('/api/health')).status === 200, 'GET /api/health -> 200')
ok((await json('/api/not-exist')).status === 404, '未匹配路由 -> 404（原先会被当 500）')

console.log('\n[2] CORS 白名单与写操作来源校验（B4）')
const evilPre = await fetch(`${BASE}/api/config`, {
  method: 'OPTIONS',
  headers: { Origin: 'http://evil.test', 'Access-Control-Request-Method': 'POST' },
})
ok(!evilPre.headers.get('access-control-allow-origin'),
  '非白名单来源预检不返回 Allow-Origin（浏览器会拦下实际请求）')
const okPre = await fetch(`${BASE}/api/config`, {
  method: 'OPTIONS',
  headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
})
ok(okPre.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
  '白名单来源预检放行')
ok((await postJson('/api/config', { llmModel: 'hacked' }, { Origin: 'http://evil.test' })).status === 403,
  '非白名单来源写请求 -> 403')
ok((await postJson('/api/config', { llmModel: 'deepseek-chat' }, { Origin: ALLOWED_ORIGIN })).status === 200,
  '白名单来源写请求 -> 200')
ok((await postJson('/api/config', { llmModel: 'deepseek-chat' })).status === 200,
  '无 Origin 头（curl / 同源部署）正常放行')

console.log('\n[3] 配置校验、脱敏与清空语义（B1 配置侧 / P2-2 / P2-18）')
ok((await postJson('/api/config', { chunkSize: 100, chunkOverlap: 500 })).status === 400,
  'overlap >= chunkSize -> 400（B1 的配置侧防线）')
ok((await postJson('/api/config', { topK: 100000 })).status === 400, 'topK 超范围 -> 400')
ok((await postJson('/api/config', { chunkSize: 'abc' })).status === 400, 'chunkSize 非整数 -> 400')
ok((await postJson('/api/config', { llmBaseUrl: 'javascript:alert(1)' })).status === 400,
  '非法协议 baseUrl -> 400')
ok((await postJson('/api/config', { llmBaseUrl: 'not a url' })).status === 400, '非法 URL -> 400')
ok((await postJson('/api/config', { llmModel: 'bad model' })).status === 400, '模型名含空白 -> 400')
ok((await postJson('/api/config', {
  chunkSize: 600, chunkOverlap: 100, topK: 6, llmApiKey: 'sk-secret-test',
})).status === 200, '合法配置 -> 200')

let cfg = (await (await json('/api/config')).json()).data
ok(cfg.topK === '6' && cfg.chunkSize === '600', `保存值回读正确（topK=${cfg.topK}, chunkSize=${cfg.chunkSize}）`)
ok(cfg.llmApiKey === '••••••••', 'API Key 只返回掩码')
ok(getSync<{ value: string }>(`SELECT value FROM settings WHERE key = 'llmApiKey'`)?.value === 'sk-secret-test',
  '（内部）库中保存原始值')

ok((await postJson('/api/config', { llmApiKey: '' })).status === 200, '空串提交 -> 200')
ok(getSync<{ value: string }>(`SELECT value FROM settings WHERE key = 'llmApiKey'`) === undefined,
  '空串使配置项被删除并回退 .env（原先无法清空）')
await postJson('/api/config', { llmApiKey: '••••••••' })
ok(getSync<{ value: string }>(`SELECT value FROM settings WHERE key = 'llmApiKey'`) === undefined,
  '掩码值提交被忽略，不写入数据')

console.log('\n[4] 对话接口参数校验（M7）')
const noConv = await postJson('/api/chat/send', { message: 'hi' })
ok(noConv.status === 400, `缺少 conversationId -> ${noConv.status}（原先为 200 + SSE error）`)
ok((noConv.headers.get('content-type') || '').includes('json'), '响应为 JSON 而非 SSE 流')
ok((await postJson('/api/chat/send', { conversationId: 999999, message: 'hi' })).status === 404,
  '会话不存在 -> 404')
ok((await json('/api/chat/conversations/999999/messages')).status === 404, '不存在会话的消息 -> 404')
ok((await json('/api/chat/conversations/abc/messages')).status === 400, '非法 id -> 400')

const conv = (await (await postJson('/api/chat/conversations', {})).json()).data
ok((await postJson('/api/chat/send', { conversationId: conv.id, message: 'x'.repeat(9000) })).status === 400,
  'message 超长 -> 400')
ok((await postJson('/api/chat/send', { conversationId: conv.id, message: 'hi', docId: 999999 })).status === 404,
  '指定文档不存在 -> 404')

console.log('\n[5] 流式问答：失败也必须成对落库（B3 / M4）')
const docReady = runSync(
  `INSERT INTO documents (name, fileType, status, chunkCount) VALUES (?, ?, ?, ?)`,
  ['ready.txt', 'txt', 'ready', 0]
).lastID
const docProcessing = runSync(
  `INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['proc.txt', 'txt', 'processing']
).lastID
ok((await postJson('/api/chat/send', { conversationId: conv.id, message: 'hi', docId: docProcessing })).status === 409,
  '未处理完成的文档作为检索范围 -> 409')

const sse = await postJson('/api/chat/send', { conversationId: conv.id, message: '知识库里有什么？', docId: docReady })
const body = await sse.text()
ok(sse.headers.get('content-type')?.includes('text/event-stream'), '成功进入 SSE 流')
ok(sse.headers.get('x-accel-buffering') === 'no', '已设置 X-Accel-Buffering: no（P2-7）')
ok(body.includes('event: degraded'), '检索失败下发 degraded 事件（不再静默降级，M4）')
ok(body.includes('event: error'), '生成失败下发 error 事件')
ok(body.includes('未配置 LLM API Key'), '错误文案是可执行的用户提示')
ok(!body.includes('\n    at '), '未把堆栈透给前端（P2-11）')

const msgs = (await (await json(`/api/chat/conversations/${conv.id}/messages`)).json()).data
ok(msgs.length === 2, `失败后消息仍成对：共 ${msgs.length} 条（user + assistant）`)
ok(msgs[0]?.role === 'user' && msgs[1]?.role === 'assistant', '顺序为 user -> assistant')
ok(String(msgs[1]?.content).includes('生成失败'), `助手侧写入明确标记：${JSON.stringify(msgs[1]?.content)}`)

console.log('\n[6] 上传校验与失败清理（P2-5 / M2）')
ok((await postJson('/api/documents/search', { query: 'x', docId: 999999 })).status === 404, '检索不存在文档 -> 404')
ok((await postJson('/api/documents/search', { query: '  ' })).status === 400, '空 query -> 400')

const upload = (name: string, bytes: number[]) => {
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(bytes)]), name)
  return fetch(`${BASE}/api/documents/upload`, { method: 'POST', body: fd })
}
ok((await upload('a.xlsx', [0x50, 0x4b])).status === 400, '不支持的扩展名 -> 400')

const fakeDocx = (await (await upload('fake.docx', [1, 2, 3, 4, 5, 6, 7, 8])).json()).data
const binaryTxt = (await (await upload('binary.txt', [0x41, 0x00, 0x42])).json()).data
await new Promise(r => setTimeout(r, 800))

const docs = (await (await json('/api/documents')).json()).data
const fake = docs.find((d: any) => d.id === fakeDocx.id)
const bin = docs.find((d: any) => d.id === binaryTxt.id)
ok(fake?.status === 'failed', `伪装 DOCX 被拒（status=${fake?.status}）`)
ok(String(fake?.errorMsg).includes('DOCX'), `原因可读：${fake?.errorMsg}`)
ok(bin?.status === 'failed' && String(bin?.errorMsg).includes('纯文本'), `二进制伪装 TXT 被拒：${bin?.errorMsg}`)
ok(getOne<{ c: number }>(`SELECT COUNT(*) c FROM chunks WHERE documentId = ?`, [fakeDocx.id]).c === 0,
  '失败文档未留下任何片段')

console.log('\n[7] 删除与片段接口的 404 语义（P2-12）')
ok((await json(`/api/documents/${docReady}/chunks`)).status === 200, '存在文档的片段列表 -> 200')
ok((await json('/api/documents/999999/chunks')).status === 404, '不存在文档的片段列表 -> 404')
ok((await json('/api/documents/abc/chunks')).status === 400, '非法 id -> 400')
ok((await fetch(`${BASE}/api/documents/${docReady}`, { method: 'DELETE' })).status === 200, '删除存在文档 -> 200')
ok((await fetch(`${BASE}/api/documents/${docReady}`, { method: 'DELETE' })).status === 404,
  '重复删除 -> 404（原先恒返回成功）')
ok((await fetch(`${BASE}/api/chat/conversations/${conv.id}`, { method: 'DELETE' })).status === 200, '删除会话 -> 200')
ok((await fetch(`${BASE}/api/chat/conversations/${conv.id}`, { method: 'DELETE' })).status === 404, '重复删除会话 -> 404')

console.log(failed === 0 ? '\n接口层用例全部通过' : `\n有 ${failed} 个用例失败`)
// 清理尽力而为：某些环境会劫持删除操作，清理失败不应影响测试结论
try {
  if (DATA_DIR.includes('.test-data')) fs.rmSync(DATA_DIR, { recursive: true, force: true })
  else console.error('拒绝清理非测试目录:', DATA_DIR)
} catch (err) {
  console.warn('测试数据目录清理失败（不影响结论）:', (err as Error).message)
}
process.exit(failed === 0 ? 0 : 1)
