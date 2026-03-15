// src/types/cookie.d.ts
// Ambient module declaration for 'cookie' (transitive dep v0.7.1; no @types/cookie available).
// Covers the parse/serialize API used in mr-ai-bot-enrollment.ts.
declare module 'cookie' {
  export function parse(str: string, options?: Record<string, unknown>): Record<string, string>;
  export function serialize(name: string, val: string, options?: Record<string, unknown>): string;
}
