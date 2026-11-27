/**
 * A rough token count for text sent to a language model, without a tokenizer: words of plain
 * letters cost about one token per 4–5 letters, numbers one per 3 digits, symbol runs like `-->`
 * one per 2 characters, each line break one, indentation one per 4 spaces, and other scripts (é, ü,
 * emoji) about one per character. Good to ±25% on Mermaid and code-like text.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|\d+|\n+|[ \t]+|[^\sA-Za-z\d\u0080-￿]+|[\u0080-￿]/gu)) {
    const s = m[0];
    if (/^[A-Za-z]/.test(s)) n += Math.max(1, Math.ceil(s.length / 4.5));
    else if (/^\d/.test(s)) n += Math.ceil(s.length / 3);
    else if (s[0] === "\n") n += s.length;
    else if (s[0] === " " || s[0] === "\t") n += Math.floor(s.length / 4);
    else if (/^[\u0080-￿]/u.test(s)) n += 1;
    else n += Math.ceil(s.length / 2);
  }
  return n;
}

export interface TextStats {
  chars: number;
  bytes: number;
  lines: number;
  tokens: number;
}

export function textStats(text: string): TextStats {
  return {
    chars: [...text].length,
    bytes: new TextEncoder().encode(text).length,
    lines: text ? text.split("\n").length : 0,
    tokens: estimateTokens(text),
  };
}
