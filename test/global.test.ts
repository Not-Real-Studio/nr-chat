import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifact = path.join(root, 'dist', 'nr-chat.global.js')

/**
 * The point of this file is the artifact, so load it the way GAS, a userscript
 * or a plain <script> would: evaluate the source in a context with no module
 * system, no require, no bundler — and see if a usable NrChat falls out.
 */
function loadGlobal(): Record<string, (...args: never[]) => unknown> {
  if (!fs.existsSync(artifact)) {
    throw new Error(`${artifact} is missing — run \`npm run build\` first (npm test does this for you)`)
  }

  const context: Record<string, unknown> = {}
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(artifact, 'utf8'), context)

  expect(context.NrChat, 'the artifact must define a NrChat global').toBeTypeOf('object')
  return context.NrChat as Record<string, (...args: never[]) => unknown>
}

describe('dist/nr-chat.global.js', () => {
  test('runs in a context with no module system at all', () => {
    const context: Record<string, unknown> = {}
    vm.createContext(context)

    expect(context.require).toBeUndefined()
    expect(context.module).toBeUndefined()
    expect(() => vm.runInContext(fs.readFileSync(artifact, 'utf8'), context)).not.toThrow()
  })

  test('exposes exactly the public surface, and no JSON5 global', () => {
    const NrChat = loadGlobal()

    expect(Object.keys(NrChat).sort()).toEqual([
      'escapeBody',
      'fenceFor',
      'parse',
      'parseJson5',
      'replaceSpan',
      'stringify',
      'stringifyJson5',
    ])
    for (const name of Object.keys(NrChat)) {
      expect(NrChat[name]).toBeTypeOf('function')
    }
  })

  test('does not leak a JSON5 global — it must not collide with the real library', () => {
    const context: Record<string, unknown> = {}
    vm.createContext(context)
    vm.runInContext(fs.readFileSync(artifact, 'utf8'), context)

    expect(context.JSON5).toBeUndefined()
    expect(Object.keys(context)).toEqual(['NrChat'])
  })

  test('parses and emits', () => {
    const NrChat = loadGlobal()
    const text = '%user Bob {a: 1}\nhi\n%assistant\nthere\n'

    const messages = NrChat.parse(text as never)
    expect(messages).toEqual([
      { role: 'user', name: 'Bob', meta: { a: 1 }, rawMeta: '{a: 1}', body: 'hi' },
      { role: 'assistant', body: 'there' },
    ])
    expect(NrChat.stringify(messages as never)).toBe(text)
  })

  test('the JSON5 methods stand on their own', () => {
    const NrChat = loadGlobal()

    expect(NrChat.parseJson5("{a: [1, 2], /* c */ b: .5, c: 'x'}" as never)).toEqual({ a: [1, 2], b: 0.5, c: 'x' })
    expect(NrChat.stringifyJson5({ 'a-b': "it's" } as never)).toBe("{'a-b': 'it\\'s'}")
  })

  test('surgery works too', () => {
    const NrChat = loadGlobal()
    const text = '$header: kept\n%user\nhi\n'

    const messages = NrChat.parse(text as never, { spans: true } as never) as { span: { start: number; end: number } }[]
    expect(NrChat.replaceSpan(text as never, messages[0].span as never, '%user\nbye' as never)).toBe('$header: kept\n%user\nbye\n')
  })

  test('is self-contained: no imports, requires or exports survive', () => {
    const source = fs.readFileSync(artifact, 'utf8')
    expect(source).not.toMatch(/^\s*(import|export)\s/m)
    expect(source).not.toMatch(/\brequire\s*\(/)
  })
})
