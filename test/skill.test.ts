import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationSchema } from "../server/ops.ts";
import { buildSkill } from "../server/skill.ts";
import { CanvasStore } from "../server/store.ts";
import { SKILL_TOOL, TOOL_SPECS, capabilities } from "../server/tools.ts";

const skill = buildSkill(TOOL_SPECS, capabilities());
const md = skill.markdown;

test("the skill is a complete SKILL.md with frontmatter and no placeholders", () => {
  const fm = /^---\nname: visual-canvas\ndescription: (.+)\n---\n/.exec(md);
  assert.ok(fm, "YAML frontmatter with name and description");
  assert.ok(fm[1].length > 50 && fm[1].length < 1024);
  assert.doesNotMatch(md, /\{\{/);
  for (const level of ["`low`", "`medium`", "`high`"]) assert.ok(md.includes(level), level);
  assert.equal(skill.meta.server_version.split(".").length, 3);
  assert.deepEqual(skill.meta.supported_levels, ["low", "medium", "high"]);
});

test("the skill names exactly the registered tools", () => {
  const mentioned = new Set(md.match(/\bcanvas_[a-z_]+/g));
  const registered = new Set(TOOL_SPECS.map((t) => t.name));
  for (const name of mentioned) assert.ok(registered.has(name), `skill mentions unknown tool ${name}`);
  for (const name of registered) assert.ok(md.includes(`**\`${name}\`**`), `tool ${name} is not documented`);
  assert.ok(registered.has(SKILL_TOOL));
});

test("every patch operation the server accepts is documented, and nothing else", () => {
  const accepted = OperationSchema.options.map((o) => o.shape.op.value as string).sort();
  const { sequence, ...flowchart } = capabilities().operations;
  const documented = [...Object.keys(flowchart), ...Object.keys(sequence)].filter((k) => k !== "position" && k !== "annotations").sort();
  assert.deepEqual(documented, accepted);
  for (const op of accepted) assert.ok(md.includes(`\`${op}\``), `${op} missing from the skill`);
});

test("every Mermaid example in the skill is accepted by this server", () => {
  const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 3);
  for (const src of blocks) {
    const store = new CanvasStore();
    store.replaceDiagram(0, src, "clear", "agent");
    assert.equal(store.snapshot().type, src.startsWith("sequenceDiagram") ? "sequence" : src.startsWith("stateDiagram") ? "state" : "flowchart");
  }
  // Inline snippets from the conventions table and the syntax lists parse too.
  const flow = new CanvasStore();
  flow.replaceDiagram(
    0,
    'flowchart TD\n s1(["Order received"])\n n1["Validate order"]\n d1{"Order valid?"}\n db[("Orders database")]\n n2["x"]\n n1 e1@--> d1\n d1 e2@-->|"Yes"| n2',
    "clear",
    "agent",
  );
  assert.match(flow.snapshot().diagram, /db\[\("Orders database"\)\]/);
  assert.equal(flow.browserState().nodes.find((n) => n.id === "db")?.shape, "store");
});
