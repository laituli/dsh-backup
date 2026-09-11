#!/usr/bin/env node
// Diagnose a dsh session transcript (possibly multi-frame zstd). Streaming and
// memory-frugal: keeps only line summaries + a bounded raw tail. Read-only.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

const arg = process.argv[2]
if (!arg || !existsSync(arg)) {
  console.error('usage: diag-session.mjs <session-dir-or-jsonl>')
  process.exit(2)
}
let file = arg
if (statSync(arg).isDirectory()) {
  const hit = readdirSync(arg).find((n) => n.endsWith('.jsonl') || n.endsWith('.jsonl.zstd'))
  if (!hit) throw new Error('no transcript in ' + arg)
  file = join(arg, hit)
}

const MAX_TAIL = Number(process.env.DIAG_TAIL || 12)
const KW = /compact|压缩|truncat|overflow|context length|too long|dispatch|无法调度|error|failed|失败/i

const counts = new Map()
const calls = new Map()
const results = new Set()
const tail = []
const hits = []
let n = 0
let bytes = 0
let carry = ''

const walkIds = (v, out) => {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) { for (const x of v) walkIds(x, out); return }
  const id = v.toolCallId || v.tool_call_id
  if (typeof id === 'string') {
    const marker = String(v.type || v.role || v.kind || '')
    if (/result|output/i.test(marker)) results.add(id)
    else out.push({ id, name: v.name || v.toolName || v.tool_name || (v.function && v.function.name) || '?', marker })
  }
  for (const k of Object.keys(v)) walkIds(v[k], out)
}

const onLine = (line) => {
  if (!line.trim()) return
  n++
  bytes += line.length
  let r
  try { r = JSON.parse(line) } catch { r = null }
  if (r) {
    const k = r.type || r.kind || r.event || Object.keys(r).slice(0, 3).join('+')
    counts.set(k, (counts.get(k) || 0) + 1)
    const out = []
    walkIds(r, out)
    for (const c of out) calls.set(c.id, c)
  }
  if (KW.test(line)) hits.push({ i: n, s: line.length > 500 ? line.slice(0, 500) + '…' : line })
  tail.push(line.length > 600 ? line.slice(0, 600) + `…(+${line.length - 600})` : line)
  if (tail.length > MAX_TAIL) tail.shift()
}

const compressed = file.endsWith('.zstd')
await new Promise((resolve, reject) => {
  const src = createReadStream(file)
  const z = compressed ? createZstdDecompress() : src
  if (compressed) { src.on('error', reject); z.on('error', reject) }
  else src.on('error', reject)
  z.on('data', (buf) => {
    carry += buf.toString('utf8')
    let idx
    while ((idx = carry.indexOf('\n')) >= 0) {
      onLine(carry.slice(0, idx))
      carry = carry.slice(idx + 1)
    }
    if (carry.length > 1 << 22) { // guard: absurdly long single line
      onLine(carry)
      carry = ''
    }
  })
  z.on('end', () => { if (carry.trim()) onLine(carry); resolve() })
  if (compressed) src.pipe(z)
})

console.log('## summary')
console.log('file    :', file)
console.log('records :', n, ` (${(bytes / 1e6).toFixed(1)} MB decompressed)`)
console.log('kinds   :', [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .map(([k, v]) => `${k}=${v}`).join('  '))

const pending = [...calls.values()].filter((c) => !results.has(c.id))
console.log('\n## tool calls')
console.log('calls / results / UNRESOLVED :', calls.size, '/', results.size, '/', pending.length)
for (const c of pending.slice(-25)) console.log('  -', c.id, c.name, `(marker=${c.marker})`)

console.log(`\n## tail (last ${tail.length})`)
for (const t of tail) console.log('  ', t)

console.log('\n## keyword hits:', hits.length, '(last 12)')
for (const h of hits.slice(-12)) console.log(`  [${h.i}]`, h.s)
