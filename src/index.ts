export { parse, stringify, replaceSpan, escapeBody, fenceFor } from './format.js'
export type { ChatMessage, ChatMessageWithSpan, ParseOptions, Span, ChatSyntaxError } from './format.js'

// The JSON5 microcodec lives in @notrealstudio/nr-json5 (NOT-287); re-exported
// here under its original names — nr-chat's surface is unchanged.
export { parseJson5, stringifyJson5 } from '@notrealstudio/nr-json5'
export type { Json5SyntaxError } from '@notrealstudio/nr-json5'
