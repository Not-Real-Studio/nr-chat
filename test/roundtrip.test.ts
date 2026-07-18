import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, stringify } from '../src/index.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8')

describe('gate-log.chat — a capture in our own format', () => {
  const text = read('gate-log.chat')

  test('parse -> stringify is byte-exact', () => {
    expect(stringify(parse(text))).toBe(text)
  })

  test('and idempotent', () => {
    const once = stringify(parse(text))
    expect(stringify(parse(once))).toBe(once)
  })

  test('the pieces it is there to cover', () => {
    const messages = parse(text)

    expect(messages.map((m) => m.role)).toEqual([
      'meta',
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'tool',
      'assistant',
    ])

    // A %meta header first: a convention, not a rule the parser knows.
    expect(messages[0].meta).toMatchObject({ format: 'nr-chat/1', source: 'llm-gate' })

    // A foreign, double-quoted meta survives verbatim.
    expect(messages[2].rawMeta).toBe('{"ts": "2026-07-15T10:22:45.002Z", "tokens": 12}')
    expect(messages[2].meta).toEqual({ ts: '2026-07-15T10:22:45.002Z', tokens: 12 })

    // A name carrying escaped braces.
    expect(messages[5].name).toBe('Bot {v2}')

    // A body holding a marker-like line, unescaped on read.
    expect(messages[5].body).toContain('\n%user Bob {a: 1}\n')

    // An empty body, and a nested meta.
    expect(messages[6]).toEqual({ role: 'user', body: '' })
    expect(messages[3].meta).toMatchObject({ tokens: { in: 38, out: 61 } })

    expect(messages[7]).toMatchObject({ role: 'tool', name: 'get_weather' })
  })
})

describe('chat3-notebook.mdz — a real notebook, mdz header and all', () => {
  const text = read('chat3-notebook.mdz')

  test('the header is ignored, not parsed', () => {
    const messages = parse(text)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(JSON.stringify(messages)).not.toContain('openrouter')
  })

  test('mdz marker attributes read as a name — the two dialects do not mix', () => {
    // `%system $frozen` is an mdz attribute upstream. nr-chat has no attribute
    // grammar, so it is simply this message's name.
    expect(parse(text)[0].name).toBe('$frozen')
  })

  test('the chat stream below the header round-trips byte-exactly', () => {
    const streamStart = text.indexOf('%system')
    expect(stringify(parse(text))).toBe(text.slice(streamStart))
  })

  test('bodies keep their blank lines and their braces', () => {
    const [system, user] = parse(text)
    expect(system.body).toBe('You are {{char}}, a terse assistant. Answer in one sentence.\n')
    expect(user.body).toBe('What is 2+2?')
  })
})

describe('crlf-notebook.md — a Windows-authored notebook', () => {
  const text = read('crlf-notebook.md')

  test('the fixture really is CRLF', () => {
    expect(text).toContain('\r\n')
    expect(text.match(/(?<!\r)\n/g)).toBe(null)
  })

  test('bodies come back without carriage returns', () => {
    for (const message of parse(text)) {
      expect(message.body).not.toContain('\r')
      expect(message.name ?? '').not.toContain('\r')
    }
  })

  test('the codec normalizes to LF — surgery is the way to keep CRLF', () => {
    const streamStart = text.indexOf('%system')
    expect(stringify(parse(text))).toBe(text.slice(streamStart).replace(/\r\n/g, '\n'))
  })
})

describe('generated streams', () => {
  test('a large stream round-trips', () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      name: i % 5 === 0 ? `Bot ${i}` : undefined,
      meta: i % 3 === 0 ? { i, ts: `2026-07-15T10:${String(i % 60).padStart(2, '0')}:00Z` } : undefined,
      body: i % 7 === 0 ? '' : `line one of ${i}\n%not-a-marker\n\nline four`,
    }))

    const text = stringify(messages as never)
    const back = parse(text)

    expect(back).toHaveLength(500)
    expect(stringify(back)).toBe(text)
    for (const [i, m] of back.entries()) {
      expect(m.body).toBe(messages[i].body)
      expect(m.name).toBe(messages[i].name)
      expect(m.meta).toEqual(messages[i].meta)
    }
  })
})
