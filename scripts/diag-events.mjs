#!/usr/bin/env node
// Extract notable event records from a decompressed session transcript.
// usage: diag-events.mjs <plain.jsonl> [type ...]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const file = process.argv[2]
const want = new Set(process.argv.slice(3))
if (!file) { console.error('usage: diag-events.mjs <jsonl> [type ...]'); process.exit(2) }
const DEFAULT = ['llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/end', 'compaction/summary',
  'command/run', 'command/done', 'session/end-seed', 'request/header', 'permission/preset', 'sandbox/mode',
  'approval/policy', 'goal/change']
const types = want.size ? want : new Set(DEFAULT)

const calls = new Map()
const results = new Set()
const lim = Number(process.env.LIMIT || 8)
const seen = new Map()

const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
for await (const line of rl) {
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  const t = r.type
  if (t === 'tool/call' && r.data?.callId) calls.set(r.data.callId, r.data.name)
  if (t === 'tool/result') {
    const id = r.data?.message?.source?.callId
    if (id) results.add(id)
  }
  if (types.has(t)) {
    const arr = seen.get(t) || []
    arr.push(r)
    if (arr.length > lim) arr.shift()
    seen.set(t, arr)
  }
}

console.log('## tool call pairing (tool/call vs tool/result)')
const pending = [...calls.entries()].filter(([id]) => !results.has(id))
console.log(`calls=${calls.size} results=${results.size} UNRESOLVED=${pending.length}`)
for (const [id, name] of pending.slice(-30)) console.log('  PENDING', id, name)

for (const [t, arr] of seen) {
  console.log(`\n## ${t}  (showing last ${arr.length})`)
  for (const r of arr) {
    const s = JSON.stringify(r.data ?? r)
    console.log('  ', s.length > 1400 ? s.slice(0, 1400) + `…(+${s.length - 1400})` : s)
  }
}
