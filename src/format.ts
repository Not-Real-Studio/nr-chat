/**
 * The `%role [name] [{meta}]` chat format: parser, canonical emitter, and the
 * one CRUD helper for in-place edits.
 */

import { parseJson5, stringifyJson5 } from './json5.js'

/** Byte offsets into the string handed to `parse`. */
export interface Span {
  /** Offset of the marker's `%`. */
  start: number
  /** End of the last body line, excluding the separator newline. */
  end: number
}

export interface ChatMessage {
  role: string
  name?: string
  meta?: Record<string, unknown>
  body: string
  /**
   * The meta exactly as it appeared in the source. `stringify` emits it verbatim
   * when present, which is what keeps someone else's meta byte-exact through a
   * round-trip. Drop it when you change `meta`, or the change will not be
   * emitted.
   */
  rawMeta?: string
}

export interface ChatMessageWithSpan extends ChatMessage {
  span: Span
}

export interface ParseOptions {
  /** Attach a `span` to every message. */
  spans?: boolean
}

/** SyntaxError carrying the 1-based line of the offending marker. */
export interface ChatSyntaxError extends SyntaxError {
  lineNumber: number
}

function syntaxError(message: string, lineNumber: number): ChatSyntaxError {
  const err = new SyntaxError(message) as ChatSyntaxError
  err.lineNumber = lineNumber
  return err
}

const RE_ROLE = /^[^\s]*/
const RE_BODY_NEEDS_ESCAPE = /^\\*%/
const RE_BODY_IS_ESCAPED = /^\\+%/

/** True for the three name escape sequences: `\{`, `\}`, `\\`. */
function isNameEscapable(c: string | undefined): boolean {
  return c === '{' || c === '}' || c === '\\'
}

/**
 * Offset of the first unescaped `{` in a marker's tail, or -1. Must stay in step
 * with `unescapeName` — both walk the same escape sequences.
 */
function findMetaStart(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (c === '\\') {
      if (isNameEscapable(rest[i + 1])) i++
      continue
    }
    if (c === '{') return i
  }
  return -1
}

function unescapeName(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && isNameEscapable(raw[i + 1])) {
      out += raw[i + 1]
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * Escape a name minimally: braces always, a backslash only where it would
 * otherwise read as one of the three escape sequences — or where it ends the
 * name, since `%u name\ {a: 1}` would swallow the meta as `\{`.
 *
 * Minimal rather than blanket escaping keeps the common case literal: a name
 * holding a Windows path emits as `C:\logs\run`, not `C:\\logs\\run`.
 */
function escapeName(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const c = name[i]
    if (c === '{' || c === '}') {
      out += '\\' + c
    } else if (c === '\\') {
      const next = name[i + 1]
      out += next === undefined || isNameEscapable(next) ? '\\\\' : '\\'
    } else {
      out += c
    }
  }
  return out
}

/** Add one rung to the ladder: `%…` → `\%…`, `\%…` → `\\%…`, and so on. */
function escapeBody(body: string): string {
  return body
    .split('\n')
    .map((line) => (RE_BODY_NEEDS_ESCAPE.test(line) ? '\\' + line : line))
    .join('\n')
}

/** Remove one rung, and normalize CRLF to LF. */
function unescapeBodyLine(line: string): string {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  return RE_BODY_IS_ESCAPED.test(bare) ? bare.slice(1) : bare
}

interface Marker {
  start: number
  lineEnd: number
  line: number
}

function scanMarkers(text: string): Marker[] {
  const markers: Marker[] = []
  let pos = 0
  let line = 1

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl === -1 ? text.length : nl
    // A marker requires a non-empty role token right after '%': a bare '%'
    // (or '% ...') line is ordinary content, not a role-less marker. This
    // keeps parse<->stringify total: stringify rejects empty roles, so no
    // parse result may contain one. The escape ladder still covers such
    // lines on write, so round-trip is unaffected.
    if (text[pos] === '%' && pos + 1 < lineEnd && /\S/.test(text[pos + 1])) {
      markers.push({ start: pos, lineEnd, line })
    }
    if (nl === -1) break
    pos = nl + 1
    line++
  }

  return markers
}

export function parse(text: string): ChatMessage[]
export function parse(text: string, options: ParseOptions & { spans: true }): ChatMessageWithSpan[]
export function parse(text: string, options?: ParseOptions): ChatMessage[]

/**
 * Parse a chat stream. Anything before the first marker is ignored — log
 * preambles and mdz headers live there. CRLF is normalized to LF; use
 * `replaceSpan` when the file's bytes must survive untouched.
 *
 * @throws {SyntaxError} with `lineNumber` when a marker's meta is not valid JSON5.
 */
export function parse(text: string, options: ParseOptions = {}): ChatMessage[] {
  const markers = scanMarkers(text)
  const messages: ChatMessage[] = []

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]

    // The separator is the newline before the next marker — `\r\n` or `\n`. It
    // belongs to the document, so the span stops short of it. The last message
    // has one only if the file ends with a newline.
    let end: number
    let hasSeparator: boolean
    if (i + 1 < markers.length) {
      end = markers[i + 1].start - 1
      hasSeparator = true
    } else if (text.endsWith('\n')) {
      end = text.length - 1
      hasSeparator = true
    } else {
      end = text.length
      hasSeparator = false
    }
    // Only a CR that precedes the separator's newline is part of it; a file
    // ending in a lone CR ends in content.
    if (hasSeparator && end > marker.start && text[end - 1] === '\r') end--

    const messageText = text.slice(marker.start, end)
    const firstNl = messageText.indexOf('\n')

    const rawMarkerLine = firstNl === -1 ? messageText : messageText.slice(0, firstNl)
    const markerLine = rawMarkerLine.endsWith('\r') ? rawMarkerLine.slice(0, -1) : rawMarkerLine

    const bodyRaw = firstNl === -1 ? '' : messageText.slice(firstNl + 1)
    const body = bodyRaw.split('\n').map(unescapeBodyLine).join('\n')

    const afterPercent = markerLine.slice(1)
    const role = RE_ROLE.exec(afterPercent)![0]
    const rest = afterPercent.slice(role.length)

    const metaStart = findMetaStart(rest)
    const namePart = (metaStart === -1 ? rest : rest.slice(0, metaStart)).trim()
    const rawMeta = metaStart === -1 ? undefined : rest.slice(metaStart)

    const message: ChatMessage = { role, body }

    if (namePart !== '') {
      message.name = unescapeName(namePart)
    }

    if (rawMeta !== undefined) {
      let parsed: unknown
      try {
        parsed = parseJson5(rawMeta)
      } catch (cause) {
        throw syntaxError(
          `nr-chat: invalid meta at line ${marker.line}: ${(cause as Error).message}`,
          marker.line,
        )
      }
      message.meta = parsed as Record<string, unknown>
      message.rawMeta = rawMeta
    }

    if (options.spans) {
      ;(message as ChatMessageWithSpan).span = { start: marker.start, end }
    }

    messages.push(message)
  }

  return messages
}

function markerLineOf(message: ChatMessage): string {
  const { role } = message

  if (typeof role !== 'string' || role === '' || /\s/.test(role)) {
    throw new TypeError(`nr-chat: role must be a non-empty whitespace-free string, got ${JSON.stringify(role)}`)
  }

  let line = '%' + role

  if (message.name) {
    line += ' ' + escapeName(message.name)
  }

  const meta = message.rawMeta ?? (message.meta ? stringifyJson5(message.meta) : undefined)
  if (meta !== undefined) {
    line += ' ' + meta
  }

  return line
}

/**
 * Emit messages as a chat stream, canonically: marker, body, `\n` between
 * messages and one at EOF.
 *
 * A message keeps its `rawMeta` verbatim; only new or changed meta (with
 * `rawMeta` dropped) gets canonicalized.
 *
 * @throws {TypeError} on a message whose role cannot be written.
 */
export function stringify(messages: ChatMessage[]): string {
  if (messages.length === 0) return ''

  return (
    messages
      .map((message) => {
        const marker = markerLineOf(message)
        return message.body ? marker + '\n' + escapeBody(message.body) : marker
      })
      .join('\n') + '\n'
  )
}

/**
 * Splice `replacement` over `span` in `text`. Every byte outside the span is
 * preserved — this is the whole of surgery mode; insert and delete are this plus
 * a span you pick. Which seam a delete takes (the leading or the trailing
 * newline) is the caller's call, and depends on where in the file the message sits.
 *
 * @throws {RangeError} if the span is not within `text`.
 */
export function replaceSpan(text: string, span: Span, replacement: string): string {
  const { start, end } = span

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
    throw new RangeError(`nr-chat: span {start: ${start}, end: ${end}} is not within a string of length ${text.length}`)
  }

  return text.slice(0, start) + replacement + text.slice(end)
}
