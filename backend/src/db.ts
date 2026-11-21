// ========== SQLite 数据库：使用 Node 内置 node:sqlite（Node 22+，零原生编译）==========
// 说明：Node 22+ 已内置 node:sqlite，无需安装 sqlite3（那个需要 node-gyp 编译 C++）。
// DatabaseSync 是同步驱动，本项目语句均为毫秒级，因此保留同步语义：
//   - 对外仍提供 async 包装（run/all/get），原有 await 调用写法不变
//   - 事务内部统一使用 *Sync 版本，保证事务体全同步、不会被 await 打断
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 数据目录可用 DATA_DIR 覆盖：便于回归测试使用独立库，避免污染开发库
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const db = new DatabaseSync(path.join(dataDir, 'minigpt.db'))

// 开启 WAL，提升并发读写
db.exec('PRAGMA journal_mode = WAL')
// 显式开启外键：级联删除依赖它。node:sqlite 默认即开启，这里显式声明，
// 避免将来驱动默认值变化导致 ON DELETE CASCADE 静默失效。
db.exec('PRAGMA foreign_keys = ON')
// 写锁等待：并发写入时等待而非立刻抛 SQLITE_BUSY
db.exec('PRAGMA busy_timeout = 5000')

// ---------- 预编译语句缓存 ----------
// node:sqlite 的 StatementSync 未提供 finalize()（Node 24 实测为 undefined），
// 无法手动释放语句对象，因此在进程内按 SQL 缓存复用，避免每次调用都重复 prepare。
const stmtCache = new Map<string, StatementSync>()
const STMT_CACHE_LIMIT = 64

function prepare(sql: string): StatementSync {
  const cached = stmtCache.get(sql)
  if (cached) return cached
  const stmt = db.prepare(sql)
  // 批量插入等动态 SQL 会引入较多条目，超过上限时淘汰最早的一条，避免缓存无界增长
  if (stmtCache.size >= STMT_CACHE_LIMIT) {
    const oldest = stmtCache.keys().next().value
    if (oldest !== undefined) stmtCache.delete(oldest)
  }
  stmtCache.set(sql, stmt)
  return stmt
}

export interface RunResult {
  lastID: number
  changes: number
}

// ---------- 同步原语（事务内部使用）----------

export function runSync(sql: string, params: any[] = []): RunResult {
  const result = prepare(sql).run(...params)
  return { lastID: Number(result.lastInsertRowid), changes: Number(result.changes) }
}

export function allSync<T = any>(sql: string, params: any[] = []): T[] {
  return prepare(sql).all(...params) as T[]
}

export function getSync<T = any>(sql: string, params: any[] = []): T | undefined {
  return prepare(sql).get(...params) as T | undefined
}

// ---------- 异步包装（保持上层 await 调用风格）----------

export async function run(sql: string, params: any[] = []): Promise<RunResult> {
  return runSync(sql, params)
}

export async function all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return allSync<T>(sql, params)
}

export async function get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  return getSync<T>(sql, params)
}

// ---------- 事务 ----------

let inTransaction = false

/**
 * 同步事务。fn 必须是同步函数——若内部出现 await，事务边界会被其他请求插进来，
 * 因此这里在检测到 Promise 返回值时直接抛错并回滚，而不是静默提交。
 * 嵌套调用自动降级为直接执行（SQLite 不支持嵌套事务）。
 */
export function transaction<T>(fn: () => T): T {
  if (inTransaction) return fn()

  db.exec('BEGIN IMMEDIATE')
  inTransaction = true
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      throw new Error('transaction() 只接受同步回调，禁止在事务内使用 await')
    }
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败不应掩盖原始错误
    }
    throw err
  } finally {
    inTransaction = false
  }
}

// ---------- 文档片段批量写入 ----------

/** 单条多值 INSERT 的行数：4 列 × 100 行 = 400 个绑定参数，远低于 SQLite 上限 */
const CHUNK_BATCH_ROWS = 100

const INSERT_CHUNK_SINGLE =
  'INSERT INTO chunks (documentId, chunkIndex, content, embedding) VALUES (?, ?, ?, ?)'
// 固定批大小，使该 SQL 字符串恒定，从而被语句缓存复用，不产生无限多的动态语句
const INSERT_CHUNK_BATCH = `INSERT INTO chunks (documentId, chunkIndex, content, embedding) VALUES ${'(?, ?, ?, ?),'.repeat(
  CHUNK_BATCH_ROWS - 1
)}(?, ?, ?, ?)`

/**
 * 批量写入文档片段。
 * 整个写入过程在一个事务内完成：要么全部成功，要么全部回滚，
 * 避免中途失败留下「半截片段被检索到」的脏数据。
 * 对应审查报告：M2（数据一致性）、M1（减少逐条同步写造成的事件循环阻塞）
 */
export function insertChunksSync(docId: number, chunks: string[], embeddings: number[][]): void {
  if (embeddings.length !== chunks.length) {
    throw new Error(
      `向量数量与片段数量不一致（片段 ${chunks.length}，向量 ${embeddings.length}）`
    )
  }

  transaction(() => {
    let i = 0
    for (; i + CHUNK_BATCH_ROWS <= chunks.length; i += CHUNK_BATCH_ROWS) {
      const params: any[] = []
      for (let k = i; k < i + CHUNK_BATCH_ROWS; k++) {
        params.push(docId, k, chunks[k], JSON.stringify(embeddings[k]))
      }
      runSync(INSERT_CHUNK_BATCH, params)
    }
    // 余数（不足一批）用单行语句补齐，最多 99 行，同样在事务内
    for (; i < chunks.length; i++) {
      runSync(INSERT_CHUNK_SINGLE, [docId, i, chunks[i], JSON.stringify(embeddings[i])])
    }
  })
}

// ---------- 初始化 ----------

export async function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      fileType TEXT NOT NULL,
      status TEXT DEFAULT 'processing',
      chunkCount INTEGER DEFAULT 0,
      errorMsg TEXT,
      createdAt TEXT DEFAULT (datetime('now','localtime'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL,
      chunkIndex INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '新对话',
      createdAt TEXT DEFAULT (datetime('now','localtime'))
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversationId INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `)
  // 运行时配置（设置页可改），键值对存字符串
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)

  // 索引：检索需按 documentId 关联文档状态过滤，取历史按 conversationId 排序
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_documentId ON chunks(documentId)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversationId ON messages(conversationId)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)')

  // 启动自愈 1：进程被强杀会留下 status='processing' 的文档，前端会因此无限轮询（审查报告 M5）
  const stale = runSync(
    `UPDATE documents SET status = 'failed', chunkCount = 0, errorMsg = ?
     WHERE status = 'processing'`,
    ['服务重启导致处理中断，请重新上传']
  )
  if (stale.changes > 0) {
    console.log(`[db] 已将 ${stale.changes} 个中断处理的文档标记为失败`)
  }

  // 启动自愈 2：清理失败文档残留的片段，避免其进入检索结果（审查报告 M2）
  const orphan = runSync(
    `DELETE FROM chunks WHERE documentId IN (SELECT id FROM documents WHERE status = 'failed')`
  )
  if (orphan.changes > 0) {
    console.log(`[db] 已清理 ${orphan.changes} 条失败文档的残留片段`)
  }
}

/** 关闭数据库（优雅退出时调用），对应审查报告 P2-10 */
export function closeDB(): void {
  try {
    stmtCache.clear()
    db.close()
  } catch (err) {
    console.error('[db] 关闭数据库失败:', err)
  }
}

// ========== 运行时配置读写 ==========

export async function getSetting(key: string): Promise<string | undefined> {
  const row = getSync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return row?.value
}

/**
 * 一次查询读取多个配置项，避免逐 key 串行往返。
 * 对应审查报告：P2-3
 */
export async function getSettings(keys: readonly string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {}
  const placeholders = keys.map(() => '?').join(',')
  const rows = allSync<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    [...keys]
  )
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key] = row.value
  return map
}

export async function setSetting(key: string, value: string): Promise<void> {
  runSync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  )
}

/** 删除配置项，使其回退到 .env 默认值。对应审查报告 P2-2（原先无法清空配置） */
export async function deleteSetting(key: string): Promise<void> {
  runSync('DELETE FROM settings WHERE key = ?', [key])
}
