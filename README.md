# nr-chat

A text format for storing and moving chat messages, and a zero-dependency library for it.

```
%system
You are a terse assistant.
%user Bob {ts: '2026-07-15T10:22:45Z'}
What is 2+2?
%assistant gpt-4o-mini {tokens: {in: 38, out: 3}}
4.
```

One line opens a message, everything until the next line that opens one is its body. That is the whole format. It is append-only, `tail -f`-readable, diffs cleanly, and costs almost nothing in an LLM context window — which is where these files mostly live, so token economy counts as much as legibility.

The library has no dependencies at all: the JSON5 reader is inside the source, not an npm import. It runs in Node, browsers, Google Apps Script, userscripts, and anywhere else with a modern JS engine.

## Install

```sh
npm install @notrealstudio/nr-chat
```

```js
import { parse, stringify } from '@notrealstudio/nr-chat'

const messages = parse(text)   // -> [{ role, name?, meta?, body }]
const text = stringify(messages)
```

Without a module system — GAS, a userscript, a plain `<script>` — use the single-file build, which exposes one global:

```html
<script src="dist/nr-chat.global.js"></script>
<script>
  const messages = NrChat.parse(text)
</script>
```

## The format

### The marker

A line that starts with `%` opens a message:

```
%role [name] [{meta}]
```

**role** is the token up to the first whitespace. The set is open — `user`, `assistant`, `system`, `tool`, `meta`, whatever you need. The format does not interpret roles.

**name** is optional: everything from the role up to the first **unescaped** `{`, trimmed at both ends. No `{` in the rest, and the whole rest is the name. An empty rest means no name and no meta. A name may contain anything — spaces, tabs, Unicode — except unescaped braces. It maps 1:1 onto the `name` field of the OpenAI protocol.

**meta** runs from the first unescaped `{` to the end of the line. It is a JSON5 object, always on one line.

```
%user                          role only
%user Bob                      name
%user {a: 1}                   meta
%user Bob {a: 1}               both
%tool_result get_weather {id: 't1'}
```

### Escapes in a name

Exactly three sequences: `\{` → `{`, `\}` → `}`, `\\` → `\`. A backslash anywhere else is a literal backslash, so paths stay readable:

```
%assistant Bot \{v2\}          name: Bot {v2}
%system C:\logs\run            name: C:\logs\run
```

`\\` has to exist: without it a name ending in a backslash could not be told apart from an escaped brace. When writing, the library escapes a backslash only where it would otherwise be read as one of the three sequences, or where it ends the name.

### The body

Everything between one marker and the next, or to end of file.

A body line that would look like a marker gets one leading backslash; reading removes one. The ladder goes all the way down, so any text round-trips:

| in the body | in the file |
| --- | --- |
| `%user` | `\%user` |
| `\%user` | `\\%user` |
| `\\%user` | `\\\%user` |
| `\just a backslash` | `\just a backslash` |

Only a leading run of backslashes followed by `%` counts. `50% done` is not a marker and is never escaped.

### Fence zones

A body often has to hold a whole other chat: a quoted log, an mds file pasted into a message. Its `%` lines would open messages in the host and tear it apart, so the format gives a guest a place where nothing is read at all:

````text
%user
look at this capture:
`````
%system
You are a terse assistant.
%assistant
ok
`````
Anything odd about it?
````

A line of **four or more backticks** opens a zone. A line of **at least as many backticks and nothing else** — trailing whitespace aside — closes it. Between the two, text is opaque in both directions: no marker is read there, and no rung of the escape ladder is added or removed. A guest comes back exactly as it went in, its own `\%` lines included.

Four, not three. Triple backticks are ordinary markdown inside bodies and always have been; taking them would re-read a great deal of text that already exists. The price is stated plainly: a `%` line inside a ``` block still needs the escape ladder. Whoever wants opacity takes four.

The info-string after the opening run is free text — a language tag, a note, nothing — and the format does not interpret it. As in CommonMark it may not contain a backtick, so a line with backticks further along is not an opener but plain text.

**An opener with no closer is not a zone.** CommonMark runs an unclosed fence to the end of the document. This format does not: a stray ```` inside quoted text would then swallow every message after it. The line stays ordinary text, reading carries on as though zones did not exist, and a shorter fence below it can still open one. Degrading to exactly what a reader without zones would say is the point.

**A zone may cross what would otherwise be a marker** — and then that marker does not exist:

````text
%user
`````
%assistant
`````
````

That is one message whose body is those four lines. It is not a case to work around; it is precisely how a guest is protected.

**Nesting is a convention, not a rule the parser enforces.** There is no recursion — the first fence long enough closes the zone. A host wraps a guest in a fence longer than the longest one inside that guest, and whatever writes the wrapper should count that, rather than leaving it to whoever is typing. Get it wrong and you get one torn message; you never get a document eaten to end of file. Past one level of guest, put it in a file and link to it.

### The seam

The newline before a marker is a **separator, not content**. It belongs to the document; a body never ends with it:

```
%user
hi
%assistant
there
```

Here `hi` and `there` are the bodies — no trailing newline on either. The file ends with a newline, and that one is a separator too. A body *can* end with a newline when it genuinely has a trailing blank line:

```
%user
hi

%assistant
```

`hi\n` is the body: the first newline ends the line `hi`, the second is the separator.

Two consequences worth knowing:

- **A lone blank line is not content.** `%user\n\n%next` and `%user\n%next` both mean an empty body, and both are written the canonical (shorter) way.
- **The file gets a trailing newline.** A file that ends without one reads fine and is written back with one.

### Anything before the first marker is ignored

Log preambles and mdz headers sit there. `parse` skips them; `stringify` does not know about them. If you need to keep them, see [surgery](#two-ways-to-work) below.

### Line endings

The reader takes CRLF and gives you LF: a `body` never contains stray carriage returns — inside a fence zone as well, since a zone is opaque to markers and escapes, not to line endings. The writer emits LF. A CRLF file put through parse → stringify comes back LF — which is a canonicalization, and canonicalizing is exactly what codec mode is allowed to do. When a file's bytes must not move, use surgery.

## JSON5

**Reading is full JSON5** — comments, unquoted keys, single quotes, trailing commas, hex, leading and trailing decimal points, `+`/`-`, `Infinity`, `NaN`, escaped and multi-line strings. The official [json5-tests](https://github.com/json5/json5-tests) suite is vendored into `test/` and passes end to end.

**Writing is canonical relaxed JSON5** — one line, stable diffs, and two emitters produce identical bytes:

- a key is bare if it matches `/^[A-Za-z_$][\w$]*$/`, otherwise single-quoted;
- strings are single-quoted, `'` becomes `\'`;
- numbers, booleans and `null` are literals; no trailing commas; one space after `:` and after `,`.

```js
stringifyJson5({ 'a-b': "it's", n: [1, 2] })   // {'a-b': 'it\'s', n: [1, 2]}
```

**Someone else's meta comes back verbatim.** `parse` keeps the raw text in `rawMeta`, and `stringify` emits it as-is. A meta only gets canonicalized when it is new or when you have changed it:

```js
const messages = parse('%user {"a":1,   "b":2}\nhi\n')
stringify(messages)                  // '%user {"a":1,   "b":2}\nhi\n' — untouched

delete messages[0].rawMeta           // opt in to canonical form
stringify(messages)                  // '%user {a: 1, b: 2}\nhi\n'
```

> **Careful:** `stringify` prefers `rawMeta` whenever it is present. Changing `meta` without dropping `rawMeta` will not show up in the output.

## Two ways to work

**Codec** — `parse` → edit the array → `stringify`. For files that are entirely yours: converters, generated corpora, in-memory sessions. Rebuilding is fine, and the canonical emit tidies up style.

**Surgery** — `parse` with spans → `replaceSpan`. For a chat stream living inside someone else's structure (an mdz header above it), or a file you must not canonicalize (a live log, something under review in a diff). Afterwards the file is byte-identical everywhere except the span you touched. That is a formal invariant, and it is covered by tests.

```js
const text = fs.readFileSync('notebook.mdz', 'utf8')   // mdz header + chat stream
const messages = parse(text, { spans: true })

const edited = replaceSpan(text, messages[2].span, '%user\nrewritten')
// the header, and every other message, byte for byte where they were
```

A span starts at the marker's `%` and ends at the last byte of the body, with the separator left out. Add and remove are this plus a span you choose — you decide which seam a removal takes, because that depends on where the message sits:

```js
const [first, middle, last] = parse(text, { spans: true })

replaceSpan(text, { start: middle.span.start, end: middle.span.end + 1 }, '')  // drop, taking the trailing seam
replaceSpan(text, { start: last.span.start - 1, end: last.span.end }, '')      // the last one takes the leading seam
replaceSpan(text, { start: first.span.end, end: first.span.end }, '\n%new\nx') // insert after the first
```

## The `%meta` convention

The role `meta` is reserved for bookkeeping — a file header in first position, checkpoints mid-stream. **The library does not interpret it.** There is no special case in the grammar; a `%meta` message has a body like any other. What goes in the fields is between you and whoever reads your files:

```
%meta {format: 'nr-chat/1', source: 'llm-gate', captured: '2026-07-15T10:22:44.901Z'}
%system
You are a terse assistant.
%user
What is 2+2?
```

## API

```ts
parse(text: string): ChatMessage[]
parse(text: string, options: { spans: true }): ChatMessageWithSpan[]
stringify(messages: ChatMessage[]): string
replaceSpan(text: string, span: Span, replacement: string): string
escapeBody(body: string): string

parseJson5(text: string): unknown
stringifyJson5(value: unknown): string

interface ChatMessage {
  role: string
  name?: string
  meta?: Record<string, unknown>
  body: string
  rawMeta?: string   // present after parse; stringify uses it when set
}

interface Span {
  start: number      // offset of the marker's `%`
  end: number        // end of the last body line, separator excluded
}
```

`escapeBody` adds one rung of the ladder to every line that needs it, skipping fence zones — the same engine `stringify` uses. It is exported for input paths that inject raw text as a body, so a "paste as quote" escapes by this rule instead of re-deriving it.

`parseJson5` and `stringifyJson5` are public in their own right — the library stands in for `json5` where you need it separately. Exports are named, and there is no `JSON5` global, so nothing collides with the real library.

**Errors.** Junk before the first marker is not an error. Broken JSON5 in a meta throws a `SyntaxError` carrying `lineNumber`. `stringify` throws a `TypeError` on a role it cannot write (empty, or containing whitespace).

`parseJson5` has no `reviver` and `stringifyJson5` no `replacer` or indent — output is always one line, by design.

## Relationship to mdz

mdz is for authoring and config: attributes, includes, `${}`. nr-chat is for storing and moving messages. Hybrids — an mdz header above a chat stream — are glued together by whoever consumes them; the parsers do not mix. nr-chat has no attribute grammar, so an mdz-style `%system $frozen` reads as a message named `$frozen`.

## Build

```sh
npm run build   # tsc -> dist/ (ESM + .d.ts), then dist/nr-chat.global.js
npm test        # builds, then runs vitest
```

Two artifacts: **ESM** with type declarations, and a **single-file global** (`dist/nr-chat.global.js`, ~37 KB) that defines `NrChat` and nothing else.

## License

MIT. The JSON5 reader is a port of [json5](https://github.com/json5/json5) (MIT, © 2012-2018 Aseem Kishore and others); see [LICENSE](./LICENSE).
