// Builds the Claude Code skill (SKILL.md) served by canvas_get_visualization_skill and /skill.md.
// The prose lives in skill/SKILL.template.md; tool names, arguments, operations and syntax are
// filled in from the same specs the MCP server registers, so the skill cannot drift from the server.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolSpec, capabilities as Capabilities } from "./tools.ts";
import { ANNOTATION_KINDS, CanvasError } from "./types.ts";

export const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const TEMPLATE = new URL("./skill/SKILL.template.md", import.meta.url);
export const DETAIL_LEVELS = ["low", "medium", "high"] as const;

export interface Skill {
  markdown: string;
  meta: {
    skill_name: string;
    skill_version: string;
    server_version: string;
    supported_levels: readonly string[];
    diagram_types: string[];
    tools: string[];
    generated_at: string;
    install_paths: { project: string; user: string };
  };
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
};

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.type === "array") {
    const item = s.items ?? {};
    if (item.anyOf || item.oneOf) return "array of operation objects (see Patch operations)";
    return `array of ${typeOf(item)}`;
  }
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  return Array.isArray(s.type) ? s.type.join(" | ") : (s.type ?? "any");
}

function renderTools(tools: ToolSpec[]): string {
  return tools
    .map((t) => {
      const schema = z.toJSONSchema(z.object(t.inputSchema), { unrepresentable: "any" }) as JsonSchema;
      const props = Object.entries(schema.properties ?? {});
      const args = props.length
        ? props
            .map(([name, p]) => `  - \`${name}\`${schema.required?.includes(name) ? "" : " (optional)"}: ${typeOf(p)}${p.description ? ` — ${p.description}` : ""}`)
            .join("\n")
        : "  - no arguments";
      return `- **\`${t.name}\`**${t.readOnly ? " (read-only)" : ""}: ${t.description}\n${args}`;
    })
    .join("\n");
}

/** Nested capability objects as a Markdown list (strings stay verbatim, so syntax examples are exact). */
function renderValue(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return value.map((v) => `${indent}- ${inline(v)}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? `${indent}- \`${k}\`:\n${renderValue(v, indent + "  ")}`
          : Array.isArray(v) && v.every((x) => typeof x === "string")
            ? `${indent}- \`${k}\`:\n${renderValue(v, indent + "  ")}`
            : `${indent}- \`${k}\`: ${inline(v)}`,
      )
      .join("\n");
  }
  return `${indent}- ${inline(value)}`;
}

function inline(v: unknown): string {
  if (typeof v !== "string") return `\`${JSON.stringify(v)}\``;
  // Mermaid snippets go in code spans; prose (anything with backticks or an explanation) stays as written.
  const snippet = /^([a-z][\w-]*[[({]|[a-z]\w* e\d+@|flowchart |class |participant )/i.test(v) && !v.includes("`") && !v.includes(" — ");
  return snippet ? `\`${v}\`` : v.replace(/\n/g, " / ");
}

function codeBlock(v: string) {
  return "```mermaid\n" + v + "\n```";
}

export function buildSkill(tools: ToolSpec[], caps: ReturnType<typeof Capabilities>): Skill {
  let template: string;
  try {
    template = readFileSync(TEMPLATE, "utf8");
  } catch (err) {
    throw new CanvasError("skill_unavailable", `the skill template could not be read (${(err as Error).message}); reinstall or restart the canvas server`);
  }
  const { example, ...sequence } = caps.sequenceDiagram;
  const { example: stateExample, ...state } = caps.stateDiagram;
  const { sequence: sequenceOps, ...flowchartOps } = caps.operations;
  const values: Record<string, string> = {
    SERVER_VERSION,
    TOOLS: renderTools(tools),
    OPERATIONS: `Flowchart and general operations:\n\n${renderValue(flowchartOps)}\n\nSequence-diagram operations:\n\n${renderValue(sequenceOps)}`,
    FLOWCHART_SYNTAX: renderValue((({ types: _types, ...rest }) => rest)(caps.diagram)),
    SEQUENCE_SYNTAX: `${renderValue(sequence)}\n\nExample:\n\n${codeBlock(example)}`,
    STATE_SYNTAX: `${renderValue(state)}\n\nExample:\n\n${codeBlock(stateExample)}`,
    LIMITS: renderValue(caps.limits),
    MARK_KINDS: ANNOTATION_KINDS.map((k) => `\`${k}\``).join(", "),
  };
  const markdown = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => values[key] ?? m);
  const unresolved = markdown.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) throw new CanvasError("skill_unavailable", `skill template has unknown placeholders: ${unresolved.join(", ")}`);
  return {
    markdown,
    meta: {
      skill_name: "visual-canvas",
      skill_version: `${SERVER_VERSION}+${createHash("sha256").update(markdown).digest("hex").slice(0, 10)}`,
      server_version: SERVER_VERSION,
      supported_levels: DETAIL_LEVELS,
      diagram_types: ["flowchart", "sequence", "state"],
      tools: tools.map((t) => t.name),
      generated_at: new Date().toISOString(),
      install_paths: { project: ".claude/skills/visual-canvas/SKILL.md", user: "~/.claude/skills/visual-canvas/SKILL.md" },
    },
  };
}
