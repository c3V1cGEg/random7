import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, textStats } from "../client/src/tokens.ts";

test("token estimate is in the right range for Mermaid", () => {
  const mermaid = `flowchart TD
    n1["Order received"] --> n2{"In stock?"}
    n2 -->|Yes| n3["Ship"]
    n2 -->|No| n4["Backorder"]
    n4 --> n3
    n3 --> n5(["Done"])`;
  const t = estimateTokens(mermaid);
  // A real tokenizer gives about 65–75 tokens for this.
  assert.ok(t >= 50 && t <= 95, `got ${t}`);
  assert.equal(estimateTokens(""), 0);
});

test("text stats count characters, UTF-8 bytes and lines", () => {
  assert.deepEqual(textStats("a\nü"), { chars: 3, bytes: 4, lines: 2, tokens: estimateTokens("a\nü") });
  assert.equal(textStats("").lines, 0);
});
