// 分块函数回归测试：边界参数必须终止且结果正确。
// 对应审查报告 B1 —— 原实现在 chunkOverlap >= chunkSize 时死循环并耗尽内存。
import { splitText } from '../src/services/splitter.js'

let failed = 0
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log('  ✅', msg)
  else { failed++; console.log('  ❌', msg) }
}

const text = 'A'.repeat(3000)

console.log('\n[1] 边界参数必须在有限时间内返回')
const cases: Array<[unknown, unknown, string]> = [
  [500, 80, '常规参数'],
  [100, 500, '重叠远大于块大小（原死循环用例）'],
  [500, 500, '重叠等于块大小'],
  [100, 100, '重叠等于块大小（小块）'],
  [50, undefined, '未传重叠且默认值大于块大小'],
  [1, 0, '最小块'],
  [0, 0, '非法块大小'],
  [NaN, NaN, '非法数值'],
  [2000, 500, '大块'],
  [-5, -5, '负数参数'],
  [500, -1, '负重叠'],
  [10_000_000, 9_999_999, '超大参数'],
]
for (const [size, overlap, label] of cases) {
  const t0 = Date.now()
  try {
    const chunks = splitText(text, size as number, overlap as number)
    const ms = Date.now() - t0
    ok(chunks.length > 0 && chunks.every(c => c.length > 0) && ms < 500,
      `${label}（size=${size}, overlap=${overlap}）-> 块数=${chunks.length}, ${ms}ms`)
  } catch (err) {
    failed++
    console.log(`  ❌ ${label} -> 抛错 ${(err as Error).message}`)
  }
}

console.log('\n[2] 结果正确性')
const normal = splitText('abcdefghij'.repeat(100), 300, 80)
ok(normal[0].startsWith('abcdefghij'), '首块从头开始')
ok(normal[normal.length - 1].endsWith('abcdefghij'), '末块覆盖到结尾')
ok(normal.every(c => c.length <= 300), '每块不超过 chunkSize')
// 相邻块应有重叠：第 n 块结尾与第 n+1 块开头有 80 字符交集
const a = normal[0]
const b = normal[1]
ok(a.slice(-80) === b.slice(0, 80), '相邻块保留 80 字符重叠')
ok(splitText('   ', 500, 80).length === 0, '空白文本返回空数组')
ok(splitText('', 500, 80).length === 0, '空字符串返回空数组')

console.log(failed === 0 ? '\n分块用例全部通过' : `\n有 ${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
