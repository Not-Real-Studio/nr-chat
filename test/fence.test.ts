import { describe, expect, test } from 'vitest'

import { escapeBody, parse, stringify, type ChatMessage } from '../src/index.js'

const F4 = '````'
const F5 = '`````'

describe('a zone hides markers', () => {
  test('a quoted chat does not split its host — the bug this exists for', () => {
    const text = ['%user', 'look at this log:', F4, '%system', 'you are terse', '%assistant', 'ok', F4, 'thoughts?', ''].join('\n')

    expect(parse(text)).toEqual([
      { role: 'user', body: ['look at this log:', F4, '%system', 'you are terse', '%assistant', 'ok', F4, 'thoughts?'].join('\n') },
    ])
  })

  test('a zone opened in one body and closed past a would-be marker eats it', () => {
    // The last bullet of the grammar: the marker does not exist, all of it is
    // one body. This is the guest protection, not a bug.
    const text = ['%user', F4, 'guest', '%assistant', 'still the guest', F4, ''].join('\n')

    expect(parse(text)).toEqual([
      { role: 'user', body: [F4, 'guest', '%assistant', 'still the guest', F4].join('\n') },
    ])
  })

  test('markers outside the zone still open messages', () => {
    const text = ['%user', F4, '%hidden', F4, '%assistant', 'hi', ''].join('\n')

    expect(parse(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  test('a zone in the preamble hides the first marker too', () => {
    expect(parse([F4, '%user', F4, '%assistant', 'hi', ''].join('\n'))).toEqual([{ role: 'assistant', body: 'hi' }])
  })
})

describe('opener', () => {
  test('three backticks are ordinary text — markdown in bodies keeps working', () => {
    const text = ['%user', '```', '%assistant', '```', ''].join('\n')

    expect(parse(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  test.each([
    ['no info-string', F4],
    ['info-string', F4 + 'chat'],
    ['info-string with spaces', F4 + ' nr-chat quoted '],
    ['five backticks', F5],
  ])('%s opens a zone', (_label, opener) => {
    const closer = opener.slice(0, opener.replace(/[^`]/g, '').length)
    const text = ['%user', opener, '%hidden', closer, ''].join('\n')

    expect(parse(text)).toEqual([{ role: 'user', body: [opener, '%hidden', closer].join('\n') }])
  })

  test('a backtick after the run is not an opener (CommonMark info-string rule)', () => {
    const text = ['%user', F4 + 'a`b', '%assistant', 'hi', F4, ''].join('\n')

    expect(parse(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  test('an indented fence is not an opener', () => {
    const text = ['%user', ' ' + F4, '%assistant', 'hi', ' ' + F4, ''].join('\n')

    expect(parse(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('closer', () => {
  test('a longer closer closes', () => {
    const text = ['%user', F4, '%hidden', F5, ''].join('\n')

    expect(parse(text)).toEqual([{ role: 'user', body: [F4, '%hidden', F5].join('\n') }])
  })

  test('a shorter fence does not close', () => {
    const text = ['%user', F5, '%hidden', F4, 'more', F5, ''].join('\n')

    expect(parse(text)).toEqual([{ role: 'user', body: [F5, '%hidden', F4, 'more', F5].join('\n') }])
  })

  test('trailing whitespace on the closer is allowed, anything else is not', () => {
    expect(parse(['%user', F4, '%hidden', F4 + '  ', ''].join('\n')).map((m) => m.role)).toEqual(['user'])
    expect(parse(['%user', F4, '%shown', F4 + 'x', ''].join('\n')).map((m) => m.role)).toEqual(['user', 'shown'])
  })

  test('the first fence long enough wins — no recursion', () => {
    // The inner opener is just text; the zone ends at the first closer.
    const text = ['%user', F4, 'a', F4, '%assistant', 'b', F4, F4, ''].join('\n')

    expect(parse(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('an unclosed zone is no zone', () => {
  test('the opener degrades to text and the scan continues as before', () => {
    const text = ['%user', 'oops:', F4, '%assistant', 'hi', ''].join('\n')

    expect(parse(text)).toEqual([
      { role: 'user', body: ['oops:', F4].join('\n') },
      { role: 'assistant', body: 'hi' },
    ])
  })

  test('byte-for-byte the no-zone reading: escapes still apply after it', () => {
    const text = ['%user', F4, '\\%escaped', ''].join('\n')

    expect(parse(text)).toEqual([{ role: 'user', body: [F4, '%escaped'].join('\n') }])
  })

  test('a shorter fence below an unclosed longer one still opens a zone', () => {
    const text = ['%user', F5, F4, '%hidden', F4, '%assistant', 'hi', ''].join('\n')

    expect(parse(text)).toEqual([
      { role: 'user', body: [F5, F4, '%hidden', F4].join('\n') },
      { role: 'assistant', body: 'hi' },
    ])
  })
})

describe('placement', () => {
  test('at the very start of a body', () => {
    expect(parse(['%user', F4, '%x', F4, ''].join('\n'))[0].body).toBe([F4, '%x', F4].join('\n'))
  })

  test('at the very end of a body, closer on the last line, no trailing newline', () => {
    expect(parse(['%user', 'text', F4, '%x', F4].join('\n'))[0].body).toBe(['text', F4, '%x', F4].join('\n'))
  })

  test('an empty zone', () => {
    expect(parse(['%user', F4, F4, ''].join('\n'))[0].body).toBe([F4, F4].join('\n'))
  })
})

describe('CRLF', () => {
  test('zones work with CRLF and bodies still come back without carriage returns', () => {
    const text = ['%user', F4, '%hidden', '\\%kept', F4, '%assistant', 'hi', ''].join('\r\n')
    const messages = parse(text)

    expect(messages).toEqual([
      { role: 'user', body: [F4, '%hidden', '\\%kept', F4].join('\n') },
      { role: 'assistant', body: 'hi' },
    ])
    for (const m of messages) expect(m.body).not.toContain('\r')
  })

  test('a CRLF closer closes', () => {
    expect(parse('%user\r\n' + F4 + '\r\n%hidden\r\n' + F4 + '\r\n').map((m) => m.role)).toEqual(['user'])
  })
})

describe('opacity in both directions', () => {
  test('parse does not unescape inside a zone', () => {
    expect(parse(['%user', F4, '\\%raw', '\\\\%raw', F4, ''].join('\n'))[0].body).toBe(
      [F4, '\\%raw', '\\\\%raw', F4].join('\n'),
    )
  })

  test('escapeBody does not escape inside a zone', () => {
    expect(escapeBody([F4, '%raw', '\\%raw', F4].join('\n'))).toBe([F4, '%raw', '\\%raw', F4].join('\n'))
  })

  test('escapeBody still escapes outside it', () => {
    expect(escapeBody(['%out', F4, '%in', F4, '%out'].join('\n'))).toBe(
      ['\\%out', F4, '%in', F4, '\\%out'].join('\n'),
    )
  })

  test('escapeBody past an unclosed opener escapes as it always did', () => {
    expect(escapeBody([F4, '%out'].join('\n'))).toBe([F4, '\\%out'].join('\n'))
  })

  test('a guest keeps its own escape ladder untouched through a round-trip', () => {
    // The point of §0.2: a raw mds source quoted as a guest, with its own `\%`
    // lines, must not be reinterpreted on the way in or out.
    const guest = ['%system', 'rules', '\\%user', '\\\\%user'].join('\n')
    const messages: ChatMessage[] = [{ role: 'user', body: [F4, guest, F4].join('\n') }]
    const text = stringify(messages)

    expect(text).toBe('%user\n' + [F4, guest, F4].join('\n') + '\n')
    expect(parse(text)).toEqual(messages)
  })
})

describe('round-trip', () => {
  const BODIES = [
    [F4, '%user', F4].join('\n'),
    [F4, 'a', '%user Bob {a: 1}', 'b', F4].join('\n'),
    ['before', F4, '%x', F4, 'after'].join('\n'),
    [F4, '\\%escaped inside', F4].join('\n'),
    ['\\%escaped outside', F4, '\\%escaped inside', F4, '%bare outside'].join('\n'),
    [F5, F4, 'nested guest', F4, F5].join('\n'),
    [F4 + 'chat', '%user', F4].join('\n'),
    [F4, F4].join('\n'),
    ['```', '%user', '```'].join('\n'),
    ['unclosed', F4, '%user'].join('\n'),
    [F4, '', '', F4].join('\n'),
  ]

  test.each(BODIES.map((b) => [b] as const))('parse(stringify(msgs)) == msgs: %j', (body) => {
    const messages: ChatMessage[] = [
      { role: 'user', body },
      { role: 'assistant', name: 'Bot', body: 'after' },
    ]
    expect(parse(stringify(messages))).toEqual(messages)
  })

  test.each(BODIES.map((b) => [b] as const))('stringify(parse(doc)) == doc: %j', (body) => {
    const doc = stringify([{ role: 'user', body }, { role: 'assistant', body: 'after' }])

    expect(stringify(parse(doc))).toBe(doc)
    expect(stringify(parse(stringify(parse(doc))))).toBe(doc)
  })

  test('a body of one whole chat, quoted', () => {
    const inner = stringify([
      { role: 'system', body: 'you are terse' },
      { role: 'user', name: 'Bob', meta: { ts: 1 }, body: 'hi\n\n%not-a-marker' },
    ])
    const messages: ChatMessage[] = [{ role: 'user', body: 'quoting:\n' + F4 + '\n' + inner + F4 }]

    expect(parse(stringify(messages))).toEqual(messages)
    // And the guest still parses on its own once unwrapped.
    expect(parse(inner)).toHaveLength(2)
  })
})

describe('the known limits, stated', () => {
  test('an unbalanced fence in one body can pair with a line in the next', () => {
    // stringify has no escape for a backtick line, by design. Two bodies that
    // each hold half a fence merge on the way back — the nesting convention
    // (host takes a longer fence) is what avoids this, not the parser.
    const messages: ChatMessage[] = [{ role: 'user', body: F4 }, { role: 'assistant', body: F4 }]

    expect(parse(stringify(messages))).toEqual([{ role: 'user', body: [F4, '%assistant', F4].join('\n') }])
  })
})
