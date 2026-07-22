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

/**
 * Fence zones — structural opacity for a guest sitting inside a body.
 *
 * A line of four or more backticks opens a zone; a line of at least as many,
 * and nothing else, closes it. What lies between is opaque in both directions:
 * markers are not scanned there and the escape ladder does not apply. That is
 * what lets a whole chat be quoted inside another one without its `%` lines
 * splitting the host message.
 *
 * Four, not three, is the minimum: ``` fences are ordinary markdown inside
 * bodies today, and taking them would reinterpret a great deal of existing
 * text. The price is that a `%` line inside a ``` block still needs the escape
 * ladder — whoever wants opacity takes four.
 */

/** Opener: the backtick run, then an info-string that may not hold a backtick. */
const RE_FENCE_OPENER = /^(`{4,})[^`]*$/
/** Closer: backticks and nothing else, bar trailing whitespace (a CR included). */
const RE_FENCE_CLOSER = /^(`{4,})[ \t\r]*$/

interface SourceLine {
  text: string
  /** Offset of the line's first byte in the text it was split from. */
  start: number
}

/** Split on `\n` keeping offsets; element-wise identical to `text.split('\n')`. */
function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let pos = 0

  for (;;) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) {
      lines.push({ text: text.slice(pos), start: pos })
      return lines
    }
    lines.push({ text: text.slice(pos, nl), start: pos })
    pos = nl + 1
  }
}

/**
 * Which lines belong to a fence zone — opener and closer included, since
 * neither could be a marker or need an escape anyway, so one mask serves the
 * marker scan and both escape paths. `null` when the text holds no zone, which
 * is the common case and lets callers skip the lookup altogether.
 *
 * An opener with no closer before the end of the text is not a zone: it stays
 * ordinary text and scanning resumes on the very next line, so a shorter fence
 * further down can still open one. This is a deliberate departure from
 * CommonMark, where an unclosed fence runs to the end of the document — here a
 * stray ```` in quoted text would then swallow every message after it, whereas
 * degrading to plain text is exactly the behaviour of a reader with no zones.
 *
 * There is no recursion: the first fence long enough closes the zone. Nesting
 * is a convention — the host takes a longer fence than its guest's longest —
 * and a hand-made mistake costs a torn message, never a document eaten to EOF.
 */
function zoneLines(lines: SourceLine[]): boolean[] | null {
  let mask: boolean[] | null = null

  for (let i = 0; i < lines.length; i++) {
    const opener = RE_FENCE_OPENER.exec(lines[i].text)
    if (!opener) continue

    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      const closer = RE_FENCE_CLOSER.exec(lines[j].text)
      if (closer && closer[1].length >= opener[1].length) {
        close = j
        break
      }
    }
    if (close === -1) continue

    mask ??= new Array<boolean>(lines.length).fill(false)
    for (let k = i; k <= close; k++) mask[k] = true
    i = close
  }

  return mask
}

/**
 * Add one rung to the escape ladder: `%…` → `\%…`, `\%…` → `\\%…`, and so on.
 *
 * The single escape engine for message bodies. `stringify` uses it internally;
 * it is also exported so input paths that inject raw text as a body — the
 * runner's `::quote` directive, an editor "paste as quote" snippet — escape by
 * the same rule instead of re-deriving it. Idempotent only up the ladder: each
 * pass adds one rung, so escape once per level of literal-ness intended.
 *
 * Zone-aware: lines inside a fence zone are left exactly as they are, which is
 * the write half of the opacity `parse` gives on read.
 */
export function escapeBody(body: string): string {
  const lines = splitLines(body)
  const inZone = zoneLines(lines)

  return lines
    .map(({ text }, i) => (!inZone?.[i] && RE_BODY_NEEDS_ESCAPE.test(text) ? '\\' + text : text))
    .join('\n')
}

/** Remove one rung, and normalize CRLF to LF. */
function unescapeBodyLine(line: string): string {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  return RE_BODY_IS_ESCAPED.test(bare) ? bare.slice(1) : bare
}

/**
 * The read half: unescape line by line, but leave a zone's lines alone.
 *
 * CRLF still normalizes inside a zone. Opacity is about markers and escapes;
 * "a body never holds a stray CR" is a document-level rule of the format, and
 * surgery, not the codec, is the path that keeps a file's bytes exactly.
 */
function unescapeBody(bodyRaw: string): string {
  const lines = splitLines(bodyRaw)
  const inZone = zoneLines(lines)

  return lines
    .map(({ text }, i) =>
      inZone?.[i] ? (text.endsWith('\r') ? text.slice(0, -1) : text) : unescapeBodyLine(text),
    )
    .join('\n')
}

interface Marker {
  start: number
  lineEnd: number
  line: number
}

function scanMarkers(text: string): Marker[] {
  const lines = splitLines(text)
  const inZone = zoneLines(lines)
  const markers: Marker[] = []

  for (let i = 0; i < lines.length; i++) {
    // Inside a zone nothing opens a message: that is the whole of the guest's
    // protection, and it is why a zone opened in one body and closed past what
    // would otherwise be the next marker simply makes that marker not exist.
    if (inZone?.[i]) continue

    const { text: line, start } = lines[i]
    // A marker requires a non-empty role token right after '%': a bare '%'
    // (or '% ...') line is ordinary content, not a role-less marker. This
    // keeps parse<->stringify total: stringify rejects empty roles, so no
    // parse result may contain one. The escape ladder still covers such
    // lines on write, so round-trip is unaffected.
    if (line[0] === '%' && line.length > 1 && /\S/.test(line[1])) {
      markers.push({ start, lineEnd: start + line.length, line: i + 1 })
    }
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
 * A fence zone (a line of 4+ backticks, closed by one of at least as many) is
 * opaque: no marker is read inside it and no escape is removed, so quoted
 * chats and other guests come through whole.
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
    // Zones are scanned per body, which agrees with the document-wide scan: a
    // body always ends at or after the closer of any zone opened inside it,
    // and no zone can be open across a marker, or that marker would not exist.
    const body = unescapeBody(bodyRaw)

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
