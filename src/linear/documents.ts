// The two Linear project documents the tool owns, found by title.
//
// `vibecheck policy` holds the project's goal, rules, authorizations and
// accepted reasons for stopping as plain sections people can edit.
// `vibecheck plan` holds a human-readable map of milestones and issues plus a
// fenced JSON block (the "machine map") that lets a second machine rebuild the
// plan-key to issue mapping. Only that JSON block is parsed. The two documents
// also record how the tool treats the project, so every machine reads the
// same answer: the machine map's `origin` says whether the tool created the
// project, and the policy document of a managed project starts with the
// tool's `Adoption: managed. ...` line (only that exact first line counts).  All functions are
// pure.

import { z } from "zod";
import type { ProjectPolicy } from "../schemas.js";
import {
  escapeField,
  escapeItem,
  parseBulletItems,
  renderBullet,
  splitMarkdownSections,
  unescapeField,
  unescapeItem,
} from "./sections.js";

export const POLICY_DOCUMENT_TITLE = "vibecheck policy";
export const POLICY_DOCUMENT_ICON = "Shield";
export const PLAN_DOCUMENT_TITLE = "vibecheck plan";
export const PLAN_DOCUMENT_ICON = "Page";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

type PolicyField = keyof ProjectPolicy;

const POLICY_HEADINGS: readonly {
  field: PolicyField;
  heading: string;
  aliases: readonly string[];
}[] = [
  { field: "goal", heading: "Goal", aliases: [] },
  { field: "rules", heading: "Rules", aliases: [] },
  {
    field: "authorizations",
    heading: "Authorizations",
    aliases: ["authorisations"],
  },
  {
    field: "stop_reasons",
    heading: "Accepted reasons for stopping",
    aliases: ["stop reasons", "accepted stop reasons"],
  },
];

function normalize(heading: string): string {
  return heading
    .replace(/[*_`]/g, "")
    .trim()
    .replace(/:+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Renders the policy document. Sections with nothing in them are left out.
 * The goal and every item are escaped (`escapeField`, `escapeItem`), so text
 * inside them can never open a section or add an item when it is read back.
 */
export function renderPolicyDocument(policy: ProjectPolicy): string {
  const blocks: string[] = [];
  for (const { field, heading } of POLICY_HEADINGS) {
    if (field === "goal") {
      const goal = policy.goal?.replace(/\r\n?/gu, "\n").trim() ?? "";
      if (goal !== "") blocks.push(`## ${heading}\n\n${escapeField(goal)}`);
      continue;
    }
    const items = (policy[field] ?? [])
      .map((item) => item.replace(/\r\n?/gu, "\n").trim())
      .filter((item) => item !== "");
    if (items.length > 0) {
      blocks.push(
        `## ${heading}\n\n${items.flatMap((item) => renderBullet(escapeItem(item))).join("\n")}`,
      );
    }
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/**
 * The first line the tool writes in the policy document of a managed
 * project. Only this exact line, as the document's first line, records the
 * managed answer: the same words anywhere else (a goal, a rule, a person's
 * note) do not.
 */
export const MANAGED_ADOPTION_LINE =
  "Adoption: managed. vibecheck may fill empty fields and add structure to this project; it never deletes, renames or overwrites what people set.";

/** Whether the policy document's first line is the tool's `MANAGED_ADOPTION_LINE`. */
export function policySaysManaged(markdown: string): boolean {
  const first = markdown.replace(/\r\n?/gu, "\n").split("\n", 1)[0] ?? "";
  return first.trim() === MANAGED_ADOPTION_LINE;
}

/**
 * Reads the policy document as it stands now, including human edits. Headings
 * are matched case-insensitively and may be H2 or H3; other text is ignored.
 */
export function parsePolicyDocument(markdown: string): ProjectPolicy {
  const policy: ProjectPolicy = {};
  for (const section of splitMarkdownSections(markdown).sections) {
    const title = normalize(section.title);
    const spec = POLICY_HEADINGS.find(
      (candidate) =>
        normalize(candidate.heading) === title ||
        candidate.aliases.includes(title),
    );
    if (spec === undefined) continue;
    const body = section.lines.slice(1);
    if (spec.field === "goal") {
      const text = unescapeField(body.join("\n").trim());
      if (text !== "") {
        policy.goal =
          policy.goal === undefined ? text : `${policy.goal}\n\n${text}`;
      }
      continue;
    }
    const items = parseBulletItems(body).map((item) => unescapeItem(item.text));
    if (items.length > 0) {
      policy[spec.field] = [...(policy[spec.field] ?? []), ...items];
    }
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Whether the tool created the Linear project or adopted an existing one. */
export type PlanOrigin = "created" | "adopted";

/**
 * The plan-key to issue map stored in the plan document. `tasks` maps a plan
 * key to its issue identifier, `milestones` a milestone code to its Linear ID,
 * `origin` records whether the tool created the project, `ready_at` when the
 * plan first passed readiness (so every machine gates its plan writes alike).
 */
export interface PlanMap {
  revision: number;
  tasks: Record<string, string>;
  milestones: Record<string, string>;
  origin?: PlanOrigin | undefined;
  /** When the plan first passed readiness (ruling 12); absent until then. */
  ready_at?: string | undefined;
}

const planMapSchema = z.object({
  revision: z.number().int().min(0),
  tasks: z.record(z.string(), z.string()),
  milestones: z.record(z.string(), z.string()),
  origin: z.enum(["created", "adopted"]).optional(),
  ready_at: z.string().optional(),
});

/** A task as listed in the human-readable part of the plan document. */
export interface PlanDocumentTask {
  key: string;
  identifier: string;
  title: string;
  /** Milestone code; absent for tasks outside any milestone. */
  milestone?: string | undefined;
  /** Plan keys or identifiers this task depends on. */
  dependsOn?: readonly string[] | undefined;
}

/** A milestone as listed in the plan document, in display order. */
export interface PlanDocumentMilestone {
  code: string;
  name: string;
}

const MACHINE_MAP_HEADING = "Machine map";

/**
 * A single-line field as the plan document shows it: on one line (line
 * breaks and runs of spaces become one space) with backticks escaped, so a
 * name read from Linear can neither start a line of its own nor open a code
 * fence.
 */
function inline(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(/`/gu, "\\`");
}

function taskLine(task: PlanDocumentTask): string {
  const deps =
    task.dependsOn !== undefined && task.dependsOn.length > 0
      ? ` (depends on ${task.dependsOn.map(inline).join(", ")})`
      : "";
  return `* ${inline(task.key)} · ${inline(task.identifier)} · ${inline(task.title)}${deps}`;
}

/**
 * Renders the plan document: tasks grouped by milestone, tasks without a
 * milestone last, the plan-wide warnings of the latest plan change (when
 * there are any), then `## Machine map` with the JSON block.
 */
export function renderPlanDocument(
  map: PlanMap,
  tasks: readonly PlanDocumentTask[],
  milestones: readonly PlanDocumentMilestone[],
  /** Plan-wide warnings of the latest plan change (plan-coverage, brief-scope). */
  warnings: readonly string[] = [],
): string {
  const blocks: string[] = [`Plan revision ${map.revision}.`];
  const known = new Set(milestones.map((milestone) => milestone.code));
  for (const milestone of milestones) {
    const own = tasks.filter((task) => task.milestone === milestone.code);
    const lines = own.length === 0 ? ["_No tasks._"] : own.map(taskLine);
    blocks.push(
      `## ${inline(milestone.code)} · ${inline(milestone.name)}\n\n${lines.join("\n")}`,
    );
  }
  const loose = tasks.filter(
    (task) => task.milestone === undefined || !known.has(task.milestone),
  );
  if (loose.length > 0) {
    blocks.push(`## No milestone\n\n${loose.map(taskLine).join("\n")}`);
  }
  if (warnings.length > 0)
    blocks.push(
      `## Warnings\n\n${warnings.map((warning) => `* ${inline(warning)}`).join("\n")}`,
    );
  blocks.push(
    `## ${MACHINE_MAP_HEADING}\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\``,
  );
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The plan document `content` with its machine map replaced by `map` and
 * `added` listed under `## No milestone`; the rest of the human-readable
 * part (a person's edits included) stays as it is.
 */
export function withPlanMap(
  content: string,
  map: PlanMap,
  added: readonly PlanDocumentTask[],
): string {
  const heading = `## ${MACHINE_MAP_HEADING}`;
  const at = content.lastIndexOf(heading);
  let head = (at === -1 ? content : content.slice(0, at))
    .trimEnd()
    .replace(/^Plan revision \d+\./u, `Plan revision ${map.revision}.`);
  if (added.length > 0) {
    const lines = added.map(taskLine).join("\n");
    head = /(^|\n)## No milestone\n/u.test(head)
      ? `${head}\n${lines}`
      : `${head}\n\n## No milestone\n\n${lines}`;
  }
  return `${head}\n\n${heading}\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`;
}

/** Fenced code blocks in order, with the heading each one sits under. */
function fencedBlocks(markdown: string): { heading: string; body: string }[] {
  const blocks: { heading: string; body: string }[] = [];
  let heading = "";
  let open: string | null = null;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    const fence = /^[ \t]*(```|~~~)/.exec(line);
    if (open === null) {
      if (fence !== null) {
        open = fence[1] ?? "```";
        body = [];
        continue;
      }
      const title = /^#{1,6}[ \t]+(.*?)[ \t]*$/.exec(line);
      if (title !== null) heading = normalize(title[1] ?? "");
    } else if (fence !== null && fence[1] === open) {
      blocks.push({ heading, body: body.join("\n") });
      open = null;
    } else {
      body.push(line);
    }
  }
  return blocks;
}

/** The first block of `blocks` that parses as JSON and matches the map schema. */
function firstMap(
  blocks: readonly { heading: string; body: string }[],
): PlanMap | null {
  for (const block of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(block.body);
    } catch {
      continue;
    }
    const parsed = planMapSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Reads the machine map: the first valid JSON block after the document's
 * LAST `## Machine map` heading, the one the tool writes at the end. The
 * text above that heading is never scanned for it, so an unbalanced fence or
 * a forged map in the human-readable part cannot hide or replace it. Without
 * such a heading (or a valid block under it), the last valid fenced block in
 * the document counts. Null when no block qualifies.
 */
export function parsePlanDocument(markdown: string): PlanMap | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const wanted = normalize(MACHINE_MAP_HEADING);
  let last = -1;
  lines.forEach((line, index) => {
    const title = /^#{1,6}[ \t]+(.*?)[ \t]*$/.exec(line);
    if (title !== null && normalize(title[1] ?? "") === wanted) last = index;
  });
  if (last !== -1) {
    const found = firstMap(fencedBlocks(lines.slice(last).join("\n")));
    if (found !== null) return found;
  }
  return firstMap(fencedBlocks(lines.join("\n")).reverse());
}
