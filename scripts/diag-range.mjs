#!/usr/bin/env node
// Dump raw records in a line range, with per-type trimming.
// usage: diag-range.mjs <jsonl> <from> <to> [maxLen] [typeRegex]
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const [file, fromS, toS, maxLenS, typeRe] = process.argv.slice(2)
const from = Number(fromS || 0)
const to = Number(toS || Number.MAX_SAFE_INTEGER)
const maxLen = Number(maxLenS || 900)
const re = typeRe ? new RegExp(typeRe) : null
const SKIP = /chunk|reasoning-chunks|tool-call-chunks|text-chunks/

const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
let i = 0
const out = []
for await (const line of rl) {
  i++
  if (i < from || i > to) continue
  if (!line.trim()) continue
  let r
  try { r = JSON.parse(line) } catch { out.push(`${i} <UNPARSED> ${line.slice(0, maxLen)}`); continue }
  if (re && !re.test(r.type)) continue
  if (SKIP.test(r.type) && (!re || !re.test(r.type))) continue
  let s = line
  const trim = (o) => {
    if (!o || typeof o !== 'object') return
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string' && o[k].length > maxLen) o[k] = o[k].slice(0, maxLen) + `…(+${o[k].length - maxLen})`
      else trim(o[k])
    }
  }
  const c = JSON.parse(JSON.stringify(r))
  trim(c)
  s = JSON.stringify(c)
  const ts = r.time ? new Date(r.time).toLocaleString('sv-SE') : ''
  out.push(`${String(i).padStart(6)} ${ts} ${r.type} ${s.length > 3 * maxLen ? s.slice(0, 3 * maxLen) + '…' : s}`)
  if (out.length > 400) { out.shift() }
}
console.log(out.join('\n'))
