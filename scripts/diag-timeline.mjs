#!/usr/bin/env node
// Timeline view: user messages, turn boundaries, session restarts, and the
// neighbourhood of a given command id. usage: diag-timeline.mjs <plain.jsonl> [cmdId]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const file = process.argv[2]
const cmdId = process.argv[3]
if (!file) { console.error('usage: diag-timeline.mjs <jsonl> [cmdId]'); process.exit(2) }

const S = (v, n = 200) => { const s = JSON.stringify(v); return s === undefined ? 'undefined' : s.slice(0, n) }
const events = []
const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
let i = 0
for await (const line of rl) {
  i++
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  const t = r.type
  const d = r.data
  if (t === 'user/message') {
    const text = (d?.message?.content ?? []).map((c) => c.type === 'text' ? c.text : `<${c.type}>`).join(' ').trim()
    events.push({ i, t, turn: d?.turn, time: r.time, text: text.slice(0, 220) })
  } else if (t === 'turn/start' || t === 'turn/end') {
    events.push({ i, t, turn: d?.turn, time: r.time, text: S(d) })
  } else if (t === 'session/end-seed' || t === 'session') {
    events.push({ i, t, time: r.time, text: S(d) })
  } else if (t === 'command/run' || t === 'command/done') {
    events.push({ i, t, time: r.time, text: S(d, 300) })
    if (cmdId && JSON.stringify(d).includes(cmdId)) events.push({ i, t: '  ^^ ' + t, time: r.time, text: 'MATCH ' + cmdId })
  } else if (t === 'tool/result' && d?.message?.content?.[0]?.isError) {
    events.push({ i, t, time: r.time, text: 'ERROR ' + S(d.message.content[0].content, 300) })
  }
}
const fmt = (e) => {
  const ts = e.time ? new Date(e.time).toLocaleString('sv-SE') : ''
  return `${String(e.i).padStart(6)} ${ts} ${e.t}${e.turn != null ? ' turn=' + e.turn : ''} :: ${e.text}`
}
console.log('## last 45 timeline events')
for (const e of events.slice(-45)) console.log(fmt(e))
if (cmdId) {
  console.log(`\n## events mentioning ${cmdId}`)
  for (const e of events.filter((x) => x.text.includes(cmdId))) console.log(fmt(e))
}
