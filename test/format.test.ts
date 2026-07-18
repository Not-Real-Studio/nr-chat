import { describe, expect, test } from 'vitest'

import { parse, stringify, type ChatMessage } from '../src/index.js'

describe('marker line', () => {
  test.each([
    ['role only', '%user', { role: 'user', body: '' }],
    ['open role set', '%tool_result', { role: 'tool_result', body: '' }],
    ['role and name', '%user Bob', { role: 'user', name: 'Bob', body: '' }],
    ['name with spaces', '%user Bob Smith', { role: 'user', name: 'Bob Smith', body: '' }],
    ['tab after role', '%user\tBob', { role: 'user', name: 'Bob', body: '' }],
    ['name is trimmed', '%user   Bob   ', { role: 'user', name: 'Bob', body: '' }],
    ['unicode name', '%user Джулия', { role: 'user', name: 'Джулия', body: '' }],
    ['meta only', '%user {a: 1}', { role: 'user', meta: { a: 1 }, rawMeta: '{a: 1}', body: '' }],
    ['name and meta', '%user Bob {a: 1}', { role: 'user', name: 'Bob', meta: { a: 1 }, rawMeta: '{a: 1}', body: '' }],
    ['name trimmed before meta', '%user   Bob   {a: 1}', { role: 'user', name: 'Bob', meta: { a: 1 }, rawMeta: '{a: 1}', body: '' }],
    ['empty rest is neither name nor meta', '%user    ', { role: 'user', body: '' }],
    ['no brace means all name', '%user no braces here', { role: 'user', name: 'no braces here', body: '' }],
    ['meta may hold braces', '%user {a: "{}"}', { role: 'user', meta: { a: '{}' }, rawMeta: '{a: "{}"}', body: '' }],
  ])('%s', (_name, input, expected) => {
    expect(parse(input)).toEqual([expected])
  })

  test('meta runs to end of line, so trailing junk is a meta error', () => {
    // Proves the meta is not cut at the first closing brace.
    expect(() => parse('%user {a: 1} {b: 2}')).toThrow(/invalid meta/)
  })

  test('a bare % is a role-less marker, not a crash', () => {
    expect(parse('%')).toEqual([{ role: '', body: '' }])
  })

  test('% only counts at the start of a line', () => {
    expect(parse('%user\n50% done')).toEqual([{ role: 'user', body: '50% done' }])
  })
})

describe('name escaping', () => {
  test.each([
    ['escaped braces are literal', String.raw`%user \{v2\}`, '{v2}'],
    ['escaped brace before meta', String.raw`%user a\{b {x: 1}`, 'a{b'],
    ['escaped closing brace', String.raw`%user a\}b`, 'a}b'],
    ['lone backslash is literal', String.raw`%user C:\logs\run`, String.raw`C:\logs\run`],
    ['lone backslash before meta', String.raw`%user C:\logs\run {a: 1}`, String.raw`C:\logs\run`],
    ['escaped backslash', String.raw`%user back\\slash`, String.raw`back\slash`],
    // The case \\ exists for: without it, a name ending in a backslash would be
    // indistinguishable from an escaped brace.
    ['backslash before meta', String.raw`%user back\\ {a: 1}`, 'back\\'],
  ])('%s', (_name, input, expectedName) => {
    expect(parse(input)[0].name).toBe(expectedName)
  })

  test('an escaped brace does not start the meta', () => {
    expect(parse(String.raw`%user \{not meta\}`)).toEqual([{ role: 'user', name: '{not meta}', body: '' }])
  })

  test.each([
    ['plain', 'Bob'],
    ['braces', '{v2}'],
    ['brace and text', 'a{b'],
    ['windows path', String.raw`C:\logs\run`],
    ['trailing backslash', 'back\\'],
    ['double backslash', String.raw`a\\b`],
    ['backslash then brace', String.raw`\{`],
    ['unicode', 'Джулия 👋'],
  ])('round-trips a name: %s', (_label, name) => {
    for (const message of [{ role: 'user', name, body: '' }, { role: 'user', name, meta: { a: 1 }, body: '' }]) {
      expect(parse(stringify([message]))[0].name).toBe(name)
    }
  })
})

describe('body', () => {
  test.each([
    ['single line', '%user\nhi', 'hi'],
    ['trailing newline is a separator', '%user\nhi\n', 'hi'],
    ['multi-line', '%user\na\nb\n', 'a\nb'],
    ['no body', '%user\n', ''],
    ['no body, next marker follows', '%user\n%a\nx\n', ''],
    ['a lone blank line is not content', '%user\n\n%a\nx\n', ''],
    ['trailing blank line inside a body survives', '%user\nhi\n\n%a\nx\n', 'hi\n'],
    ['interior blank lines survive', '%user\na\n\nb\n', 'a\n\nb'],
    ['leading blank line survives', '%user\n\nhi\n', '\nhi'],
  ])('%s', (_name, input, expectedBody) => {
    expect(parse(input)[0].body).toBe(expectedBody)
  })
})

describe('body escape ladder', () => {
  test.each([
    ['a marker-like line is escaped once', '%user\n\\%foo\n', '%foo'],
    ['an escaped line gains a rung', '%user\n\\\\%foo\n', '\\%foo'],
    ['and another', '%user\n\\\\\\%foo\n', '\\\\%foo'],
    ['a backslash not before % is untouched', '%user\n\\foo\n', '\\foo'],
    ['only the leading run counts', '%user\nx \\%foo\n', 'x \\%foo'],
  ])('%s', (_name, input, expectedBody) => {
    expect(parse(input)[0].body).toBe(expectedBody)
  })

  test.each([
    ['%user Bob {a: 1}'],
    ['\\%user'],
    ['\\\\%user'],
    ['\\\\\\%user'],
    ['%'],
    ['\\%'],
    ['not a marker'],
    ['\\not a marker'],
  ])('a body line round-trips at any depth: %j', (line) => {
    const messages: ChatMessage[] = [{ role: 'user', body: line }, { role: 'assistant', body: 'after' }]
    expect(parse(stringify(messages))).toEqual(messages)
  })

  test('an escaped body line does not split the message', () => {
    expect(parse('%user\nbefore\n\\%assistant\nafter\n')).toEqual([
      { role: 'user', body: 'before\n%assistant\nafter' },
    ])
  })
})

describe('edges', () => {
  test('anything before the first marker is ignored', () => {
    const text = '2026-07-15 gate: listening\nrandom noise\n%user\nhi\n'
    expect(parse(text)).toEqual([{ role: 'user', body: 'hi' }])
  })

  test('a file with no marker at all yields nothing', () => {
    expect(parse('just prose\nand more\n')).toEqual([])
    expect(parse('')).toEqual([])
  })

  test('EOF without a trailing newline', () => {
    expect(parse('%user\nhi')).toEqual([{ role: 'user', body: 'hi' }])
    expect(parse('%user')).toEqual([{ role: 'user', body: '' }])
  })

  test('consecutive markers with no bodies', () => {
    expect(parse('%a\n%b\n%c\n')).toEqual([
      { role: 'a', body: '' },
      { role: 'b', body: '' },
      { role: 'c', body: '' },
    ])
  })

  test('CRLF is normalized to LF', () => {
    expect(parse('%user Bob {a: 1}\r\nline1\r\nline2\r\n%assistant\r\nhi\r\n')).toEqual([
      { role: 'user', name: 'Bob', meta: { a: 1 }, rawMeta: '{a: 1}', body: 'line1\nline2' },
      { role: 'assistant', body: 'hi' },
    ])
  })
})

describe('meta errors', () => {
  test('broken JSON5 throws with the marker line number', () => {
    expect(() => parse('%user {a: }')).toThrow(/invalid meta at line 1/)
  })

  test('the line number counts the ignored preamble', () => {
    const text = 'noise\nmore noise\n%user\nhi\n%assistant {oops: @}\n'
    try {
      parse(text)
      throw new Error('expected a throw')
    } catch (err) {
      const e = err as Error & { lineNumber: number }
      expect(e.lineNumber).toBe(5)
      expect(e.message).toMatch(/invalid meta at line 5/)
    }
  })

  test('the error is a SyntaxError', () => {
    expect(() => parse('%user {')).toThrow(SyntaxError)
  })
})

describe('stringify', () => {
  test.each([
    ['no messages', [], ''],
    ['role only', [{ role: 'user', body: '' }], '%user\n'],
    ['body', [{ role: 'user', body: 'hi' }], '%user\nhi\n'],
    ['name', [{ role: 'user', name: 'Bob', body: '' }], '%user Bob\n'],
    ['meta', [{ role: 'user', meta: { a: 1 }, body: '' }], '%user {a: 1}\n'],
    ['name and meta', [{ role: 'user', name: 'Bob', meta: { a: 1 }, body: '' }], '%user Bob {a: 1}\n'],
    ['empty name is no name', [{ role: 'user', name: '', body: 'x' }], '%user\nx\n'],
    ['two messages', [{ role: 'user', body: 'a' }, { role: 'assistant', body: 'b' }], '%user\na\n%assistant\nb\n'],
    ['empty body between', [{ role: 'user', body: '' }, { role: 'assistant', body: 'b' }], '%user\n%assistant\nb\n'],
  ])('%s', (_name, messages, expected) => {
    expect(stringify(messages as ChatMessage[])).toBe(expected)
  })

  test('meta is canonicalized', () => {
    expect(stringify([{ role: 'user', meta: { 'a-b': "it's", n: [1, 2] }, body: '' }])).toBe("%user {'a-b': 'it\\'s', n: [1, 2]}\n")
  })

  test.each([
    ['empty', ''],
    ['whitespace', '  '],
    ['contains a space', 'two words'],
    ['contains a tab', 'a\tb'],
    ['contains a newline', 'a\nb'],
  ])('rejects an unwritable role: %s', (_label, role) => {
    expect(() => stringify([{ role, body: '' }])).toThrow(TypeError)
  })

  test('emitting twice is byte-identical', () => {
    const messages: ChatMessage[] = [
      { role: 'user', name: 'Bob', meta: { b: 2, a: 1 }, body: 'hi' },
      { role: 'assistant', body: 'there' },
    ]
    expect(stringify(messages)).toBe(stringify(structuredClone(messages)))
  })
})

describe('rawMeta', () => {
  test('a foreign meta comes back verbatim', () => {
    const text = '%user {"a":1,   "b":[2,3]}\nhi\n'
    const messages = parse(text)
    expect(messages[0].rawMeta).toBe('{"a":1,   "b":[2,3]}')
    expect(messages[0].meta).toEqual({ a: 1, b: [2, 3] })
    expect(stringify(messages)).toBe(text)
  })

  test('dropping rawMeta canonicalizes', () => {
    const messages = parse('%user {"a":1}\nhi\n')
    delete messages[0].rawMeta
    expect(stringify(messages)).toBe('%user {a: 1}\nhi\n')
  })

  test('rawMeta wins over a changed meta — the documented footgun', () => {
    const messages = parse('%user {"a":1}\nhi\n')
    messages[0].meta = { a: 999 }
    expect(stringify(messages)).toBe('%user {"a":1}\nhi\n')
  })

  test('a new message with no rawMeta is canonical', () => {
    expect(stringify([{ role: 'user', meta: { a: 1 }, body: '' }])).toBe('%user {a: 1}\n')
  })
})

describe('parse -> stringify is stable', () => {
  test.each([
    ['%user\nhi\n'],
    ['%user Bob {a: 1}\nhi\n%assistant\nthere\n'],
    ['%a\n%b\n%c\n'],
    ['%user\nhi\n\n%a\nx\n'],
    ['%user {a: 1}\n\\%escaped\n'],
    ['%meta {v: 1}\n%system\nrules\n%user Джулия\nпривет\n'],
  ])('%j', (text) => {
    expect(stringify(parse(text))).toBe(text)
    // And idempotent: a second pass changes nothing.
    expect(stringify(parse(stringify(parse(text))))).toBe(text)
  })
})
