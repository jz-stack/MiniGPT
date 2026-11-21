// 数据层回归测试：批量写入、事务原子性、检索状态过滤、向量维度处理。
// 对应审查报告 M1 / M2 / P2-4。
// 使用独立 DATA_DIR，不触碰开发库 backend/data。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../.test-data/db')
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.env.DATA_DIR = DATA_DIR

const { initDB, closeDB, insertChunksSync, transaction, runSync, getSync } = await import('../src/db.js')
const { searchSimilar, cosineSimilarity, clampTopK } = await import('../src/services/vector.js')

/** 读取单行且断言存在，便于测试里直接取字段 */
const getOne = <T,>(sql: string, params: any[] = []): T => getSync<T>(sql, params) as T

let failed = 0
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log('  ✅', msg)
  else { failed++; console.log('  ❌', msg) }
}

await initDB()

// 8 维单位基向量
const basis = (i: number) => Array.from({ length: 8 }, (_, k) => (k === i % 8 ? 1 : 0))

console.log('\n[1] 批量写入（含 100 条的批次边界）')
const doc1 = runSync(
  `INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['a.txt', 'txt', 'ready']
).lastID
const chunks = Array.from({ length: 250 }, (_, i) => `片段内容-${i}`)
insertChunksSync(doc1, chunks, chunks.map((_, i) => basis(i)))
ok(getOne<{ c: number }>(`SELECT COUNT(*) c FROM chunks WHERE documentId = ?`, [doc1]).c === 250,
  '250 条全部写入')
ok(getOne<{ c: number }>(
  `SELECT COUNT(DISTINCT chunkIndex) c FROM chunks WHERE documentId = ?`, [doc1]).c === 250,
  'chunkIndex 无重复')
ok(getOne<{ m: number }>(
  `SELECT MAX(chunkIndex) m FROM chunks WHERE documentId = ?`, [doc1]).m === 249,
  'chunkIndex 连续递进')
ok(getOne<{ content: string }>(
  `SELECT content FROM chunks WHERE documentId = ? AND chunkIndex = 0`, [doc1]).content === '片段内容-0',
  '写入顺序与输入一致')

console.log('\n[2] 向量数量与片段数量不一致时不得写入')
const before = getOne<{ c: number }>(`SELECT COUNT(*) c FROM chunks`).c
let threw = false
try { insertChunksSync(doc1, ['x', 'y'], [[1, 0]]) } catch { threw = true }
ok(threw, '抛出了错误')
ok(getOne<{ c: number }>(`SELECT COUNT(*) c FROM chunks`).c === before, '未写入任何行')

console.log('\n[3] 事务原子性')
const docBefore = getOne<{ c: number }>(`SELECT COUNT(*) c FROM documents`).c

try {
  transaction(() => {
    runSync(`INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['rb.txt', 'txt', 'ready'])
    throw new Error('boom')
  })
} catch { /* 预期 */ }
ok(getOne<{ c: number }>(`SELECT COUNT(*) c FROM documents`).c === docBefore, '抛错后整体回滚')

let nestedThrew = false
try {
  transaction(() => {
    runSync(`INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['n.txt', 'txt', 'ready'])
    insertChunksSync(doc1, ['a', 'b'], [[1, 0]]) // 内层抛错
  })
} catch { nestedThrew = true }
ok(nestedThrew, '嵌套事务内层错误向外传递')
ok(getOne<{ c: number }>(`SELECT COUNT(*) c FROM documents`).c === docBefore, '嵌套场景同样完整回滚')

transaction(() => {
  const d = runSync(
    `INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['n-ok.txt', 'txt', 'ready']
  ).lastID
  insertChunksSync(d, ['p', 'q'], [basis(0), basis(1)])
})
ok(getOne<{ c: number }>(
  `SELECT COUNT(*) c FROM chunks WHERE documentId = (SELECT id FROM documents WHERE name = 'n-ok.txt')`
).c === 2, '嵌套事务正常提交')

let asyncRejected = false
try { await (transaction as any)(async () => 1) } catch { asyncRejected = true }
ok(asyncRejected, '拒绝 async 回调（避免事务边界被 await 破坏）')

console.log('\n[4] 检索只返回 ready 文档的片段（M2）')
const docFailed = runSync(
  `INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['bad.txt', 'txt', 'failed']
).lastID
insertChunksSync(docFailed, Array.from({ length: 20 }, (_, i) => `失败文档片段-${i}`),
  Array.from({ length: 20 }, () => basis(0)))
const results = await searchSimilar(basis(0), 50)
ok(results.length > 0, `检索返回 ${results.length} 条`)
ok(!results.some(r => r.documentId === docFailed), 'failed 文档的片段未进入结果')
ok(results.every(r => r.documentName), '每条结果带文档名（JOIN 生效）')

console.log('\n[5] 向量维度不一致时不可比')
const docDim = runSync(
  `INSERT INTO documents (name, fileType, status) VALUES (?, ?, ?)`, ['dim.txt', 'txt', 'ready']
).lastID
insertChunksSync(docDim, ['16 维片段'], [Array.from({ length: 16 }, (_, k) => (k === 0 ? 1 : 0))])
ok(!(await searchSimilar(basis(0), 50)).some(r => r.documentId === docDim),
  '维度不一致的片段被排除（不会算出假分数）')
ok(cosineSimilarity([1, 0], [1, 0, 0]) === 0, '维度不一致时余弦相似度返回 0')

console.log('\n[6] Top-K 收敛（P2-4）')
ok(clampTopK(1e9) === 50, `clampTopK(1e9) = ${clampTopK(1e9)}`)
ok(clampTopK(0) === 1, `clampTopK(0) = ${clampTopK(0)}`)
ok(clampTopK('abc') === 4, `clampTopK('abc') 回退默认 = ${clampTopK('abc')}`)

closeDB()
// 清理尽力而为：某些环境会劫持删除操作，清理失败不应影响测试结论
try {
  if (DATA_DIR.includes('.test-data')) fs.rmSync(DATA_DIR, { recursive: true, force: true })
  else console.error('拒绝清理非测试目录:', DATA_DIR)
} catch (err) {
  console.warn('测试数据目录清理失败（不影响结论）:', (err as Error).message)
}
console.log(failed === 0 ? '\n数据层用例全部通过' : `\n有 ${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
