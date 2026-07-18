import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, replaceSpan, stringify, type Span } from '../src/index.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8')

/** The invariant surgery exists for: nothing outside the span moves. */
function expectOnlySpanChanged(text: string, span: Span, replacement: string) {
  const out = replaceSpan(text, span, replacement)
  expect(out.slice(0, span.start)).toBe(text.slice(0, span.start))
  expect(out.slice(span.start, span.start + replacement.length)).toBe(replacement)
  expect(out.slice(span.start + replacement.length)).toBe(text.slice(span.end))
  return out
}

describe('spans', () => {
  test('a span covers the marker through the last body line, and no separator', () => {
    const text = '%user\nhi\n%assistant\nthere\n'
    const [first, second] = parse(text, { spans: true })

    expect(text.slice(first.span.start, first.span.end)).toBe('%user\nhi')
    expect(text.slice(second.span.start, second.span.end)).toBe('%assistant\nthere')
    expect(text[first.span.end]).toBe('\n')
  })

  test('an empty body ends the span at the marker', () => {
    const text = '%user\n%assistant\nhi\n'
    const [first] = parse(text, { spans: true })
    expect(text.slice(first.span.start, first.span.end)).toBe('%user')
  })

  test('spans are offsets into the string as given, preamble included', () => {
    const text = 'header line\n\n%user\nhi\n'
    const [message] = parse(text, { spans: true })
    expect(message.span.start).toBe(text.indexOf('%user'))
    expect(text.slice(message.span.start, message.span.end)).toBe('%user\nhi')
  })

  test('EOF without a newline', () => {
    const text = '%user\nhi'
    const [message] = parse(text, { spans: true })
    expect(message.span.end).toBe(text.length)
  })

  test('a trailing CR with no newline after it is content, not a separator', () => {
    const text = '%user\nhi\r'
    const [message] = parse(text, { spans: true })
    // Nothing follows the CR, so there is no seam for it to belong to; leaving
    // it outside the span would strand it after a replaceSpan.
    expect(message.span.end).toBe(text.length)
    expect(replaceSpan(text, message.span, '%user\nbye')).toBe('%user\nbye')
  })

  test('a CRLF separator belongs to the document, not the message', () => {
    const text = '%user\r\nhi\r\n%assistant\r\nthere\r\n'
    const [first, second] = parse(text, { spans: true })
    expect(text.slice(first.span.start, first.span.end)).toBe('%user\r\nhi')
    expect(text.slice(first.span.end)).toMatch(/^\r\n%assistant/)
    expect(text.slice(second.span.start, second.span.end)).toBe('%assistant\r\nthere')
  })

  test('every span concatenated with its separator rebuilds the stream', () => {
    const text = read('gate-log.chat')
    const messages = parse(text, { spans: true })
    const first = messages[0].span.start

    let rebuilt = text.slice(0, first)
    for (const [i, m] of messages.entries()) {
      rebuilt += text.slice(m.span.start, m.span.end)
      rebuilt += i + 1 < messages.length ? text.slice(m.span.end, messages[i + 1].span.start) : text.slice(m.span.end)
    }
    expect(rebuilt).toBe(text)
  })

  test('spans are absent unless asked for', () => {
    expect(parse('%user\nhi')[0]).not.toHaveProperty('span')
  })
})

describe('replaceSpan', () => {
  test('rejects a span outside the text', () => {
    expect(() => replaceSpan('abc', { start: 0, end: 99 }, 'x')).toThrow(RangeError)
    expect(() => replaceSpan('abc', { start: -1, end: 2 }, 'x')).toThrow(RangeError)
    expect(() => replaceSpan('abc', { start: 2, end: 1 }, 'x')).toThrow(RangeError)
  })

  test('replaces the middle message of an mdz hybrid, byte for byte', () => {
    const text = read('chat3-notebook.mdz')
    const messages = parse(text, { spans: true })
    const target = messages[messages.length - 1]

    const replacement = stringify([{ role: 'user', body: 'What is 3+3?' }]).replace(/\n$/, '')
    const out = expectOnlySpanChanged(text, target.span, replacement)

    // The mdz header is not ours to touch, and it is still there.
    expect(out.startsWith('$type: chat3\n$provider: openrouter\n')).toBe(true)
    expect(parse(out).map((m) => m.body)).toEqual([messages[0].body, 'What is 3+3?'])
  })

  test('replaces a message in a CRLF file without converting the file', () => {
    const text = read('crlf-notebook.md')
    const messages = parse(text, { spans: true })
    const out = expectOnlySpanChanged(text, messages[1].span, '%user\r\nПока!')

    expect(out).toContain('\r\n')
    expect(out.match(/(?<!\r)\n/g)).toBe(null)
  })

  test('editing one message leaves every other byte alone', () => {
    const text = read('gate-log.chat')
    const messages = parse(text, { spans: true })

    for (const message of messages) {
      expectOnlySpanChanged(text, message.span, '%replaced\nnew body')
    }
  })

  test('delete: the caller picks which seam goes with it', () => {
    const text = '%a\nx\n%b\ny\n%c\nz\n'
    const messages = parse(text, { spans: true })

    // A middle message takes its trailing separator.
    const middle = messages[1]
    expect(replaceSpan(text, { start: middle.span.start, end: middle.span.end + 1 }, '')).toBe('%a\nx\n%c\nz\n')

    // The last message takes its leading one.
    const last = messages[2]
    expect(replaceSpan(text, { start: last.span.start - 1, end: last.span.end }, '')).toBe('%a\nx\n%b\ny\n')

    // The first behaves like a middle one.
    const first = messages[0]
    expect(replaceSpan(text, { start: first.span.start, end: first.span.end + 1 }, '')).toBe('%b\ny\n%c\nz\n')
  })

  test('delete: the only message', () => {
    const text = '%a\nx\n'
    const [only] = parse(text, { spans: true })
    expect(replaceSpan(text, { start: only.span.start, end: only.span.end + 1 }, '')).toBe('')
  })

  test('insert: an empty span at a seam', () => {
    const text = '%a\nx\n%b\ny\n'
    const [first] = parse(text, { spans: true })

    // After the first message, before its separator.
    const after = replaceSpan(text, { start: first.span.end, end: first.span.end }, '\n%new\nz')
    expect(after).toBe('%a\nx\n%new\nz\n%b\ny\n')
    expect(parse(after).map((m) => m.role)).toEqual(['a', 'new', 'b'])

    // Before the first message.
    const before = replaceSpan(text, { start: first.span.start, end: first.span.start }, '%new\nz\n')
    expect(parse(before).map((m) => m.role)).toEqual(['new', 'a', 'b'])
  })

  test('append: at EOF', () => {
    const text = '%a\nx\n'
    expect(replaceSpan(text, { start: text.length, end: text.length }, '%b\ny\n')).toBe('%a\nx\n%b\ny\n')
  })

  test('surgery keeps a foreign meta the codec would rewrite', () => {
    const text = '%user {"a":1}\nhi\n%assistant {"b":2}\nthere\n'
    const messages = parse(text, { spans: true })

    const out = replaceSpan(text, messages[1].span, '%assistant {"b":3}\nthere')
    expect(out).toBe('%user {"a":1}\nhi\n%assistant {"b":3}\nthere\n')
    // The untouched message kept its JSON-style meta, spaces and all.
    expect(out).toContain('%user {"a":1}')
  })
})
