// plan_publish, plan_edit, plan_read, plan_ack and issue_adopt: the plan as
// a Linear project.
//
// A plan fills every field Linear accepts: the project (name, icon, color,
// summary, overview, priority, status, dates with their resolution, project
// labels, links), label groups (single-select) and labels reused by name,
// milestones named `<code> · <name>`, documents including the tool's own
// `vibecheck policy` and `vibecheck plan`, and one issue per task with a
// key-prefixed title, the description sections, priority, estimate, labels,
// milestone, parent, due date and the viewer as assignee, plus `blocks`
// relations for every dependency. Everything is validated before the first
// write; a request that fails validation writes nothing.
//
// One code path computes the writes. In managed mode the first plan write
// returns them as a dry run and writes nothing until the same request is
// repeated with `confirm: true`: the dry run's request hash is kept, and a
// confirm that does not match the dry run shown returns that request's dry
// run instead. Managed writes only fill empty values (null, empty text, no
// priority; an estimate of 0 is a value), add missing description sections
// and keep every existing line, and change a set value only when the request
// names it in `overwrite` (or when the tool itself set it and the plan
// changed it); a label of a single-select group the issue already has a
// label in is a set value too. As-is mode refuses plan writes.
//
// Created objects carry client ids derived from the project and the object,
// so a publish retried after a failure finds what the first attempt created
// instead of duplicating it.
//
// Two coordinators may publish the same revision at once: both pass the
// revision check, and the second plan document write would drop the first's
// keys. The plan document is re-read right before and right after the write;
// when it holds another map for this revision (or a newer one missing this
// call's keys), the maps are merged (both journals, plus tool-created issues
// titled with a key prefix that neither names) into the next revision, and
// the result says `merged_with`.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BoardError, type ValidationIssue } from "../errors.js";
import type {
  Document,
  ExternalLink,
  Issue,
  IssueFields,
  Label,
  LinearApi,
  Milestone,
  Project,
  ProjectFields,
  ProjectStatus,
  WorkflowState,
} from "../linear/api.js";
import {
  MANAGED_ADOPTION_LINE,
  PLAN_DOCUMENT_ICON,
  PLAN_DOCUMENT_TITLE,
  POLICY_DOCUMENT_ICON,
  POLICY_DOCUMENT_TITLE,
  parsePlanDocument,
  renderPlanDocument,
  renderPolicyDocument,
  withPlanMap,
  type PlanMap,
  type PlanOrigin,
} from "../linear/documents.js";
import { isLinearError, removeLabelIfPresent } from "../linear/errors.js";
import {
  missingSections,
  parseDescription,
  renderDescription,
  type TaskSections,
} from "../linear/sections.js";
import type {
  JournalRevision,
  JournalTask,
  ProjectRow,
  SessionRow,
} from "../local/types.js";
import {
  documentDefinitionSchema,
  labelDefinitionSchema,
  labelGroupSchema,
  linkDefinitionSchema,
  milestoneCodeSchema,
  milestoneDefinitionSchema,
  projectDefinitionSchema,
  projectPolicySchema,
  taskDefinitionSchema,
  type IssueAdopt,
  type MilestoneDefinition,
  type PlanAck,
  type PlanEdit,
  type PlanPublish,
  type PlanRead,
  type ProjectDefinition,
  type ProjectPolicy,
  type TaskDefinition,
} from "../schemas.js";
import {
  otherWorkText,
  standardClaims,
  type OtherTask,
  type StandardTask,
} from "../jev/standard.js";
import {
  describeEntry,
  planDetailEntries,
  recordEntries,
  type PendingEntry,
  type PlanView,
  type VerificationItem,
} from "../verification/ledger.js";
import { isReservedLabel, renderVerdictComment } from "../linear/states.js";
import { taskDuplicateBattery } from "../jev/batteries.js";
import {
  MANAGED_PREFIXES_EXISTING_TITLES,
  OPEN_WORK,
  currentRevision,
  projectKeyOf,
  requireAdopted,
  requireCoordinator,
  requireLinked,
  requireProject,
  requireSession,
  sessionIdOf,
  touchSession,
} from "./access.js";
import {
  alreadyExists,
  authorOf,
  freshId,
  stableId,
  workspaceFor,
  Writer,
  type LedgerDeps,
  type Workspace,
} from "./context.js";
import {
  JUDGMENT_UNAVAILABLE,
  NOT_READY_MESSAGE,
  applyAccept,
  completenessProblems,
  entryProblems,
  type Completeness,
  type PlanProblem,
} from "./readiness.js";
import { plainTitle, taskView } from "./snapshot.js";
import { resolveIssue, setPlanMapRefresher } from "./work.js";

// ---------------------------------------------------------------------------
// The stored plan
// ---------------------------------------------------------------------------

const codedMilestoneSchema = milestoneDefinitionSchema.extend({
  code: milestoneCodeSchema,
});
type CodedMilestone = z.infer<typeof codedMilestoneSchema>;

/** The plan-level part of a revision, stored in the journal. */
const planRecordSchema = z.object({
  project: projectDefinitionSchema,
  policy: projectPolicySchema.optional(),
  label_groups: z.array(labelGroupSchema),
  labels: z.array(labelDefinitionSchema),
  milestones: z.array(codedMilestoneSchema),
  documents: z.array(documentDefinitionSchema),
  links: z.array(linkDefinitionSchema),
  milestone_ids: z.record(z.string(), z.string()),
});
type PlanRecord = z.infer<typeof planRecordSchema>;

interface PlanState {
  record: PlanRecord;
  tasks: TaskDefinition[];
}

const definitionSchema = taskDefinitionSchema;

function readPlan(journal: JournalRevision | undefined): PlanState | undefined {
  if (journal === undefined || journal.plan === null) return undefined;
  const record = planRecordSchema.parse(journal.plan);
  return {
    record,
    tasks: journal.tasks.map((task) => definitionSchema.parse(task.definition)),
  };
}

function withCodes(
  milestones: readonly MilestoneDefinition[],
): CodedMilestone[] {
  return milestones.map((milestone, index) => ({
    ...milestone,
    code: milestone.code ?? `M${index + 1}`,
  }));
}

function milestoneName(milestone: CodedMilestone): string {
  return `${milestone.code} · ${milestone.name}`;
}

function issueTitle(task: TaskDefinition): string {
  return `${task.key}: ${task.title}`;
}

// ---------------------------------------------------------------------------
// Validation, before any write
// ---------------------------------------------------------------------------

class Issues {
  readonly list: ValidationIssue[] = [];
  add(field: (string | number)[], message: string): void {
    this.list.push({ field, message, type: "plan" });
  }
  throwIfAny(): void {
    if (this.list.length > 0)
      throw new BoardError(
        "invalid",
        `The plan is not valid: ${this.list
          .slice(0, 5)
          .map((issue) => `${issue.field.join(".")}: ${issue.message}`)
          .join(
            "; ",
          )}${this.list.length > 5 ? ` (and ${this.list.length - 5} more)` : ""}`,
        this.list,
      );
  }
}

/** Every reference outside the plan, resolved to its issue. */
type ExternalRefs = Map<string, Issue>;

/** Checks an edge list for unknown targets, self edges and cycles. */
function checkGraph(
  tasks: readonly TaskDefinition[],
  field: "depends_on" | "parent" | "supersedes",
  known: ReadonlySet<string>,
  external: ExternalRefs,
  issues: Issues,
): void {
  const edges = new Map<string, string[]>();
  tasks.forEach((task, index) => {
    const targets =
      field === "parent"
        ? task.parent === undefined
          ? []
          : [task.parent]
        : (task[field] ?? []);
    if (new Set(targets).size !== targets.length)
      issues.add(["tasks", index, field], "references must be unique");
    for (const target of targets) {
      if (target === task.key)
        issues.add(
          ["tasks", index, field],
          `${task.key} cannot reference itself`,
        );
      else if (!known.has(target) && !external.has(target.toUpperCase()))
        issues.add(
          ["tasks", index, field],
          `${target} is neither a task in this plan nor an issue in the project`,
        );
    }
    edges.set(
      task.key,
      targets.filter((target) => known.has(target)),
    );
  });
  if (field === "supersedes") return;
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]): boolean => {
    const seen = state.get(key);
    if (seen === "done") return false;
    if (seen === "visiting") {
      issues.add(
        ["tasks"],
        `${field} references form a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}`,
      );
      return true;
    }
    state.set(key, "visiting");
    for (const next of edges.get(key) ?? [])
      if (visit(next, [...path, key])) return true;
    state.set(key, "done");
    return false;
  };
  for (const key of edges.keys()) if (visit(key, [])) break;
}

/** Creation order: dependencies and parents before the tasks that name them. */
function creationOrder(
  tasks: readonly TaskDefinition[],
  issues: Issues,
): TaskDefinition[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const order: TaskDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (task: TaskDefinition): void => {
    const seen = state.get(task.key);
    if (seen === "done") return;
    if (seen === "visiting") {
      issues.add(
        ["tasks"],
        `${task.key}: parent and dependency links together form a cycle`,
      );
      return;
    }
    state.set(task.key, "visiting");
    for (const ref of [
      ...(task.depends_on ?? []),
      ...(task.parent === undefined ? [] : [task.parent]),
    ]) {
      const next = byKey.get(ref);
      if (next !== undefined) visit(next);
    }
    state.set(task.key, "done");
    order.push(task);
  };
  for (const task of tasks) visit(task);
  return order;
}

/** Whether `key` has the shape of an issue identifier of the team (`TA-12`), any case. */
function isTeamIdentifier(key: string, teamKey: string): boolean {
  return new RegExp(`^${teamKey}-\\d+$`, "iu").test(key);
}

/**
 * The plan with every identifier-shaped key and reference (`ta-12`) in
 * upper case, as Linear writes identifiers: an identifier matches in any
 * case everywhere.
 */
function withIdentifierCase(next: PlanState, teamKey: string): PlanState {
  const upper = (ref: string) =>
    isTeamIdentifier(ref, teamKey) ? ref.toUpperCase() : ref;
  return {
    record: next.record,
    tasks: next.tasks.map((task) =>
      taskDefinitionSchema.parse({
        ...task,
        key: upper(task.key),
        ...(task.depends_on === undefined
          ? {}
          : { depends_on: task.depends_on.map(upper) }),
        ...(task.supersedes === undefined
          ? {}
          : { supersedes: task.supersedes.map(upper) }),
        ...(task.parent === undefined ? {} : { parent: upper(task.parent) }),
      }),
    ),
  };
}

/** The team key of the project's team. */
async function teamKeyOf(api: LinearApi, project: ProjectRow): Promise<string> {
  const team = (await api.teams()).find((entry) => entry.id === project.teamId);
  if (team === undefined)
    throw new BoardError(
      "not_found",
      `The Linear key no longer sees team ${project.teamId}.`,
    );
  return team.key;
}

interface ValidationContext {
  readonly workspace: Workspace;
  readonly api: LinearApi;
  readonly project: ProjectRow;
  readonly teamKey: string;
  /** Plan keys mapped to issues by the previous revision. */
  readonly mapped: ReadonlyMap<string, JournalTask>;
  readonly previous: PlanState | undefined;
  readonly openIssueIds: ReadonlySet<string>;
}

async function validatePlan(
  next: PlanState,
  context: ValidationContext,
): Promise<{ external: ExternalRefs; order: TaskDefinition[] }> {
  const issues = new Issues();
  const { record, tasks } = next;
  const keys = new Set<string>();
  const identifierPattern = new RegExp(`^${context.teamKey}-\\d+$`, "iu");
  tasks.forEach((task, index) => {
    if (keys.has(task.key))
      issues.add(["tasks", index, "key"], `task key ${task.key} appears twice`);
    keys.add(task.key);
    if (
      identifierPattern.test(task.key) &&
      !context.mapped.has(task.key) &&
      context.project.adoption !== "managed"
    )
      issues.add(
        ["tasks", index, "key"],
        `${task.key} looks like an issue identifier; choose a plan key such as AREA-KIND-1`,
      );
  });
  for (const key of context.previous?.tasks.map((task) => task.key) ?? [])
    if (!keys.has(key))
      issues.add(
        ["tasks"],
        `existing task ${key} cannot be omitted; cancel it with status "cancelled" instead`,
      );

  // References outside the plan must be issues of the project.
  const external: ExternalRefs = new Map();
  const outside = new Set<string>();
  for (const task of tasks)
    for (const ref of [
      ...(task.depends_on ?? []),
      ...(task.supersedes ?? []),
      ...(task.parent === undefined ? [] : [task.parent]),
    ])
      if (!keys.has(ref)) outside.add(ref);
  for (const task of tasks)
    if (identifierPattern.test(task.key) && !context.mapped.has(task.key))
      outside.add(task.key);
  for (const ref of outside) {
    const issue = await context.api.issue(ref);
    if (issue !== null && issue.projectId === context.project.linearProjectId)
      external.set(ref.toUpperCase(), issue);
  }
  tasks.forEach((task, index) => {
    if (
      identifierPattern.test(task.key) &&
      !context.mapped.has(task.key) &&
      context.project.adoption === "managed" &&
      !external.has(task.key.toUpperCase())
    )
      issues.add(
        ["tasks", index, "key"],
        `${task.key} looks like an issue identifier but is not an issue of the project`,
      );
  });
  checkGraph(tasks, "depends_on", keys, external, issues);
  checkGraph(tasks, "parent", keys, external, issues);
  checkGraph(tasks, "supersedes", keys, external, issues);

  // Milestones.
  const codes = new Set<string>();
  const names = new Set<string>();
  record.milestones.forEach((milestone, index) => {
    if (codes.has(milestone.code))
      issues.add(
        ["milestones", index, "code"],
        `milestone code ${milestone.code} appears twice`,
      );
    codes.add(milestone.code);
    const name = milestoneName(milestone).toLowerCase();
    if (names.has(name))
      issues.add(
        ["milestones", index, "name"],
        `milestone ${milestoneName(milestone)} appears twice`,
      );
    names.add(name);
  });
  tasks.forEach((task, index) => {
    if (task.milestone !== undefined && !codes.has(task.milestone))
      issues.add(
        ["tasks", index, "milestone"],
        `milestone ${task.milestone} is not declared in milestones`,
      );
  });

  // Reserved names: vc:* and agent:* belong to the tool (any case).
  const reserved = (path: (string | number)[], name: string, what: string) => {
    if (isReservedLabel(name))
      issues.add(
        path,
        `${what} ${name} uses a reserved prefix: names starting with vc: or agent: (any case) belong to vibecheck's own labels`,
      );
  };
  record.label_groups.forEach((group, groupIndex) => {
    reserved(["label_groups", groupIndex, "name"], group.name, "label group");
    group.labels.forEach((label, labelIndex) =>
      reserved(
        ["label_groups", groupIndex, "labels", labelIndex, "name"],
        label.name,
        "label",
      ),
    );
  });
  record.labels.forEach((label, index) =>
    reserved(["labels", index, "name"], label.name, "label"),
  );
  tasks.forEach((task, index) =>
    (task.labels ?? []).forEach((name, labelIndex) =>
      reserved(["tasks", index, "labels", labelIndex], name, "label"),
    ),
  );

  // Labels: groups are single-select; each task takes one label per group.
  const groupOf = new Map<string, string>();
  const declared = new Set<string>();
  record.label_groups.forEach((group, groupIndex) => {
    const groupName = group.name.toLowerCase();
    if (declared.has(groupName))
      issues.add(
        ["label_groups", groupIndex, "name"],
        `label ${group.name} is declared twice`,
      );
    declared.add(groupName);
    group.labels.forEach((label, labelIndex) => {
      const name = label.name.toLowerCase();
      if (declared.has(name))
        issues.add(
          ["label_groups", groupIndex, "labels", labelIndex, "name"],
          `label ${label.name} is declared twice`,
        );
      declared.add(name);
      groupOf.set(name, group.name);
    });
  });
  record.labels.forEach((label, index) => {
    const name = label.name.toLowerCase();
    if (declared.has(name))
      issues.add(
        ["labels", index, "name"],
        `label ${label.name} is declared twice`,
      );
    declared.add(name);
  });
  // Every plan label is resolved against Linear's labels first: a label
  // that exists inside a Linear group stays in that group (it is never
  // re-parented), and a plan group must not reuse the name of a plain label.
  const workspaceLabels = await context.workspace.labels();
  const parentName = new Map(
    workspaceLabels.map((label) => [label.id, label.name]),
  );
  for (const [groupIndex, group] of record.label_groups.entries()) {
    const existing = await context.workspace.findLabel(group.name);
    if (existing !== undefined && !existing.isGroup)
      issues.add(
        ["label_groups", groupIndex, "name"],
        `plan label group ${group.name} has the same name as the existing Linear label ${existing.name}, which is a plain label and not a group: rename the plan group or the Linear label`,
      );
    for (const [labelIndex, label] of group.labels.entries()) {
      const found = await context.workspace.findLabel(label.name);
      if (found?.isGroup === true)
        issues.add(
          ["label_groups", groupIndex, "labels", labelIndex, "name"],
          `label ${label.name} of plan group ${group.name} is a label group in Linear, which cannot be applied to an issue`,
        );
    }
  }
  /** The Linear group a label lands in: its existing parent, or the existing group its plan group names. */
  const linearGroupOf = async (name: string): Promise<string | undefined> => {
    const existing = await context.workspace.findLabel(name);
    if (existing !== undefined)
      return existing.parentId === null
        ? undefined
        : parentName.get(existing.parentId);
    const planGroup = groupOf.get(name.toLowerCase());
    if (planGroup === undefined) return undefined;
    const groupLabel = await context.workspace.findLabel(planGroup);
    return groupLabel?.isGroup === true ? groupLabel.name : undefined;
  };
  for (const [index, task] of tasks.entries()) {
    const perGroup = new Map<string, string[]>();
    const perLinearGroup = new Map<string, string[]>();
    for (const [labelIndex, name] of (task.labels ?? []).entries()) {
      const lower = name.toLowerCase();
      const group = groupOf.get(lower);
      const existing = await context.workspace.findLabel(name);
      if (group !== undefined)
        perGroup.set(group, [...(perGroup.get(group) ?? []), name]);
      else if (!declared.has(lower) && existing === undefined)
        issues.add(
          ["tasks", index, "labels", labelIndex],
          `label ${name} is neither declared in the plan nor an existing label`,
        );
      // Linear takes one label per group, by the groups labels really have.
      const linearGroup = await linearGroupOf(name);
      if (linearGroup !== undefined)
        perLinearGroup.set(linearGroup, [
          ...(perLinearGroup.get(linearGroup) ?? []),
          name,
        ]);
    }
    const reported = new Set<string>();
    for (const group of record.label_groups) {
      const chosen = perGroup.get(group.name) ?? [];
      if (chosen.length === 0)
        issues.add(
          ["tasks", index, "labels"],
          `${task.key} needs one label from group ${group.name} (${group.labels.map((label) => label.name).join(", ")})`,
        );
      if (chosen.length > 1) {
        reported.add(group.name.toLowerCase());
        issues.add(
          ["tasks", index, "labels"],
          `${task.key} has ${chosen.length} labels from single-select group ${group.name}: ${chosen.join(", ")}`,
        );
      }
    }
    for (const [group, chosen] of perLinearGroup)
      if (chosen.length > 1 && !reported.has(group.toLowerCase()))
        issues.add(
          ["tasks", index, "labels"],
          `${task.key} has ${chosen.length} labels from Linear label group ${group}, which takes one: ${chosen.join(", ")}`,
        );
  }

  // Documents and links.
  const titles = new Set<string>();
  record.documents.forEach((document, index) => {
    const title = document.title.toLowerCase();
    if (title === POLICY_DOCUMENT_TITLE || title === PLAN_DOCUMENT_TITLE)
      issues.add(
        ["documents", index, "title"],
        `${document.title} is the tool's own document`,
      );
    if (titles.has(title))
      issues.add(
        ["documents", index, "title"],
        `document ${document.title} appears twice`,
      );
    titles.add(title);
  });
  const urls = new Set<string>();
  record.links.forEach((link, index) => {
    if (urls.has(link.url))
      issues.add(["links", index, "url"], `link ${link.url} appears twice`);
    urls.add(link.url);
  });

  // A claimed task cannot be cancelled through the plan.
  tasks.forEach((task, index) => {
    const mapped = context.mapped.get(task.key);
    if (
      task.status === "cancelled" &&
      mapped !== undefined &&
      context.openIssueIds.has(mapped.issueId)
    )
      issues.add(
        ["tasks", index, "status"],
        `${task.key} is claimed; its work must be released before it can be cancelled`,
      );
  });

  const order = creationOrder(tasks, issues);
  issues.throwIfAny();
  return { external, order };
}

// ---------------------------------------------------------------------------
// Field decisions per mode
// ---------------------------------------------------------------------------

export interface PlannedChange {
  readonly object: string;
  readonly key: string;
  readonly action: "create" | "update";
  readonly fields?: Readonly<
    Record<string, { readonly old: unknown; readonly new: unknown }>
  >;
}

export interface SkippedField {
  readonly object: string;
  readonly key: string;
  readonly field: string;
  readonly old: unknown;
  readonly new: unknown;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Whether managed mode may fill a field: it holds nothing (null, empty text
 * or list) or, for a priority, Linear's 0 ("No priority"). Any other number,
 * an estimate of 0 included, is a value someone set.
 */
function isUnset(path: string, current: unknown): boolean {
  if (isEmptyValue(current)) return true;
  return current === 0 && /(^|\.)priority$/u.test(path);
}

class Decider {
  readonly changes: PlannedChange[] = [];
  readonly skipped: SkippedField[] = [];
  private readonly managed: boolean;
  private readonly overwrite: ReadonlySet<string>;

  constructor(managed: boolean, overwrite: readonly string[]) {
    this.managed = managed;
    this.overwrite = new Set(overwrite);
  }

  /**
   * Whether to write `desired` over `current`. Created mode writes what the
   * plan changed since its previous revision; managed mode fills empty
   * values, values the tool itself set before, and fields named in
   * `overwrite` (`<object>.<key>.<field>` or `project.<field>`).
   */
  wants(
    path: string,
    current: unknown,
    desired: unknown,
    previous: unknown,
  ): boolean {
    if (desired === undefined) return false;
    if (isDeepStrictEqual(current, desired)) return false;
    if (!this.managed)
      return previous === undefined || !isDeepStrictEqual(previous, desired);
    if (isUnset(path, current)) return true;
    if (this.overwrite.has(path)) return true;
    return previous !== undefined && isDeepStrictEqual(current, previous);
  }

  /** Collects the fields to write for one object; records skipped ones. */
  fields(
    object: string,
    key: string,
    entries: readonly {
      readonly field: string;
      readonly current: unknown;
      readonly desired: unknown;
      readonly previous: unknown;
    }[],
  ): Map<string, unknown> {
    const out = new Map<string, unknown>();
    const prefix = object === "project" ? "project" : `${object}.${key}`;
    for (const entry of entries) {
      if (
        this.wants(
          `${prefix}.${entry.field}`,
          entry.current,
          entry.desired,
          entry.previous,
        )
      )
        out.set(entry.field, entry.desired);
      else if (
        this.managed &&
        entry.desired !== undefined &&
        !isDeepStrictEqual(entry.current, entry.desired)
      )
        this.skipped.push({
          object,
          key,
          field: entry.field,
          old: entry.current,
          new: entry.desired,
        });
    }
    return out;
  }

  record(change: PlannedChange): void {
    this.changes.push(change);
  }
}

function changeFields(
  values: ReadonlyMap<string, unknown>,
  current: Readonly<Record<string, unknown>>,
): Record<string, { old: unknown; new: unknown }> {
  return Object.fromEntries(
    [...values].map(([field, value]) => [
      field,
      { old: current[field] ?? null, new: value },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const SECTION_FIELDS: readonly (keyof TaskSections)[] = [
  "goal",
  "report",
  "original_behaviour",
  "root_cause",
  "evidence",
  "files",
  "approach",
  "depends_on",
  "criteria",
  "rules",
  "exceptions",
  "out_of_scope",
];

/** The sections a task definition renders, with dependencies already resolved to identifiers. */
function desiredSections(
  task: TaskDefinition,
  dependencies: { identifier: string; title: string }[] | undefined,
): TaskSections {
  return {
    ...(task.goal === undefined ? {} : { goal: task.goal }),
    ...(task.report === undefined ? {} : { report: task.report }),
    ...(task.original_behaviour === undefined
      ? {}
      : { original_behaviour: task.original_behaviour }),
    ...(task.root_cause === undefined ? {} : { root_cause: task.root_cause }),
    ...(task.evidence === undefined ? {} : { evidence: task.evidence }),
    ...(task.files === undefined ? {} : { files: [...task.files] }),
    ...(task.approach === undefined ? {} : { approach: task.approach }),
    ...(dependencies === undefined ? {} : { depends_on: dependencies }),
    ...(task.criteria === undefined
      ? {}
      : { criteria: task.criteria.map((text) => ({ text, done: false })) }),
    ...(task.rules === undefined ? {} : { rules: [...task.rules] }),
    ...(task.exceptions === undefined
      ? {}
      : { exceptions: [...task.exceptions] }),
    ...(task.out_of_scope === undefined
      ? {}
      : { out_of_scope: [...task.out_of_scope] }),
  };
}

/** A section's value in a form two descriptions can be compared by. */
function sectionValue(
  sections: TaskSections,
  field: keyof TaskSections,
): unknown {
  const value = sections[field];
  if (value === undefined) return undefined;
  if (field === "criteria")
    return (sections.criteria ?? []).map((criterion) => criterion.text.trim());
  if (field === "depends_on")
    return (sections.depends_on ?? []).map((dep) =>
      dep.identifier.toUpperCase(),
    );
  if (typeof value === "string") return value.trim();
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// The plan run
// ---------------------------------------------------------------------------

interface RunInput {
  readonly deps: LedgerDeps;
  readonly project: ProjectRow;
  readonly session: SessionRow;
  readonly previous: PlanState | undefined;
  readonly journal: JournalRevision | undefined;
  readonly next: PlanState;
  readonly requestId: string;
  readonly dryRun: boolean;
  readonly overwrite: readonly string[];
  readonly update:
    | {
        readonly health?: "onTrack" | "atRisk" | "offTrack" | undefined;
        readonly body: string;
      }
    | undefined;
  readonly source: "ledger:plan_publish" | "ledger:plan_edit";
  /** Problem ids the request accepts (ruling 12). */
  readonly accept: readonly string[];
}

/** Label groups a plan should declare (by name, any case), as detailed real projects do. */
const RECOMMENDED_GROUPS = ["Kind", "Area"];

/** Fields left empty, per object. */
function completenessOf(
  record: PlanRecord,
  tasks: readonly TaskDefinition[],
  project: Project | null,
  existing: boolean,
): Completeness {
  const result: Completeness = {};
  const fields = record.project;
  const missing: string[] = [];
  const has = (planValue: unknown, linearValue: unknown) =>
    !isEmptyValue(planValue) || !isEmptyValue(linearValue);
  if (!has(fields.icon, project?.icon)) missing.push("icon");
  // Linear gives every project a default color, so only a color the plan or
  // a person chose counts.
  if (!has(fields.color, existing ? project?.color : undefined))
    missing.push("color");
  if (!has(fields.summary, project?.description)) missing.push("summary");
  if (!has(fields.overview, project?.content)) missing.push("overview");
  if (!has(fields.start_date, project?.startDate)) missing.push("start_date");
  if (!has(fields.target_date, project?.targetDate))
    missing.push("target_date");
  if (fields.priority === undefined && (project?.priority ?? 0) === 0)
    missing.push("priority");
  if (!has(fields.labels, project?.labelIds)) missing.push("labels");
  if (record.links.length === 0) missing.push("links");
  if (missing.length > 0) result.project = missing;
  const milestones: Record<string, string[]> = {};
  for (const milestone of record.milestones) {
    const empty = [
      ...(milestone.description === undefined ? ["description"] : []),
      ...(milestone.target_date === undefined ? ["target_date"] : []),
    ];
    if (empty.length > 0) milestones[milestone.code] = empty;
  }
  if (Object.keys(milestones).length > 0) result.milestones = milestones;
  const groupLabels = record.label_groups.map((group) => ({
    name: group.name,
    labels: new Set(group.labels.map((label) => label.name.toLowerCase())),
  }));
  const perTask: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.status === "cancelled") continue;
    const empty = [
      ...(task.goal === undefined ? ["goal"] : []),
      ...((task.criteria ?? []).length === 0 ? ["criteria"] : []),
      ...((task.files ?? []).length === 0 ? ["files"] : []),
      ...(task.approach === undefined ? ["approach"] : []),
      ...((task.labels ?? []).length === 0 ? ["labels"] : []),
      ...groupLabels
        .filter(
          (group) =>
            !(task.labels ?? []).some((label) =>
              group.labels.has(label.toLowerCase()),
            ),
        )
        .map((group) => `labels:${group.name}`),
      ...(task.priority === undefined ? ["priority"] : []),
      ...(task.estimate === undefined ? ["estimate"] : []),
    ];
    if (empty.length > 0) perTask[task.key] = empty;
  }
  if (Object.keys(perTask).length > 0) result.tasks = perTask;
  const declared = new Set(
    record.label_groups.map((group) => group.name.toLowerCase()),
  );
  const missingGroups = RECOMMENDED_GROUPS.filter(
    (name) => !declared.has(name.toLowerCase()),
  );
  if (missingGroups.length > 0)
    result.recommended = { label_groups: missingGroups };
  return result;
}

function statusIdFor(
  statuses: readonly ProjectStatus[],
  status: ProjectDefinition["status"],
): string | undefined {
  if (status === undefined) return undefined;
  return statuses.find((entry) => entry.type === status)?.id;
}

async function createOr<T>(
  create: () => Promise<T>,
  read: () => Promise<T | undefined>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const found = await read();
    if (found === undefined) throw error;
    return found;
  }
}

/**
 * Creates one of the tool's own documents with its stable id. When Linear
 * says the id exists but no live document has it, a person trashed the
 * old one: a live document with the same title is used, or else the
 * document is created with a fresh id (the caller records that id).
 */
async function createToolDocument(
  api: LinearApi,
  input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly icon: string;
    readonly content: string;
  },
): Promise<Document> {
  try {
    return await api.createDocument(input);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const documents = await api.documents(input.projectId);
    const found =
      documents.find((entry) => entry.id === input.id) ??
      documents.find((entry) => entry.title === input.title);
    if (found !== undefined) return found;
    return api.createDocument({ ...input, id: freshId() });
  }
}

function standardOf(task: TaskDefinition, status: string): StandardTask {
  return {
    key: task.key,
    title: task.title,
    status,
    details: {
      ...(task.goal === undefined ? {} : { goal: task.goal }),
      ...(task.criteria === undefined ? {} : { criteria: [...task.criteria] }),
      ...(task.rules === undefined ? {} : { rules: [...task.rules] }),
      ...(task.exceptions === undefined
        ? {}
        : { exceptions: [...task.exceptions] }),
    },
  };
}

/**
 * The plan-time checks over a plan write, read before anything is written:
 * plan-detail on new and changed tasks, and with a judgment source
 * brief-scope, task-duplicate and plan-coverage. Without a judgment source
 * only the first publish reads plan-detail (its readiness gate needs it).
 */
async function planTimeEntries(
  input: RunInput,
  mapped: ReadonlyMap<string, JournalTask>,
): Promise<PendingEntry[]> {
  const { deps, project, session, previous, next } = input;
  const cached = new Map(
    deps.store.cachedIssues(project.key).map((issue) => [issue.id, issue]),
  );
  const statusOf = (task: TaskDefinition): string => {
    const entry = mapped.get(task.key);
    const issue = entry === undefined ? undefined : cached.get(entry.issueId);
    if (issue === undefined)
      return task.status === "cancelled" ? "cancelled" : "pending";
    return taskView(issue, task.key, new Map(), null).status;
  };
  const prevTasks = new Map(
    (previous?.tasks ?? []).map((task) => [task.key, task]),
  );
  const changed = next.tasks.filter((task) => {
    const prev = prevTasks.get(task.key);
    return prev === undefined || !isDeepStrictEqual(prev, task);
  });
  const detail = (config: Parameters<typeof planDetailEntries>[4]) =>
    planDetailEntries(
      project.key,
      session.id,
      changed.map((task) => standardOf(task, statusOf(task))),
      input.source,
      config,
    );
  if (deps.verifier === undefined)
    return isReady(project) ? [] : detail(undefined);
  const after: PlanView = {
    revision: project.planRevision + 1,
    tasks: next.tasks.map((task) => standardOf(task, statusOf(task))),
    policy: next.record.policy,
  };
  const before: PlanView | undefined =
    previous === undefined
      ? undefined
      : {
          revision: project.planRevision,
          tasks: previous.tasks.map((task) =>
            standardOf(task, task.status ?? "pending"),
          ),
          policy: previous.record.policy,
        };
  // The work others hold (a claim of another session here, `vc:claimed` on
  // the cached issue, or an issue started in Linear): a change that leaves
  // it to them does not narrow it. Only held tasks are listed; unclaimed
  // ones stay in the coordinator's standard with their criteria.
  const labelNames = await workspaceFor(deps, project.teamId).labelNames(
    [...cached.values()].flatMap((issue) => issue.labelIds),
  );
  const claimedTasks: OtherTask[] = (previous?.tasks ?? []).flatMap((task) => {
    const entry = mapped.get(task.key);
    if (entry === undefined) return [];
    const issue = cached.get(entry.issueId);
    return [
      {
        ...standardOf(task, statusOf(task)),
        issueId: entry.issueId,
        identifier: entry.identifier,
        labels: (issue?.labelIds ?? []).flatMap((id) => {
          const name = labelNames.get(id);
          return name === undefined ? [] : [name];
        }),
      },
    ];
  });
  const open = deps.store
    .openWork(project.key)
    .filter((work) => OPEN_WORK.has(work.status));
  const otherWork = otherWorkText(
    claimedTasks,
    standardClaims(
      open.filter((work) => work.sessionId !== session.id),
      deps.store.sessions(project.key),
    ),
    new Set(
      open
        .filter((work) => work.sessionId === session.id)
        .map((work) => work.issueId),
    ),
    [],
    { heldOnly: true, started: true },
  );
  return [
    ...(await deps.verifier.afterPlanChange(
      project.key,
      session.id,
      before,
      after,
      input.source,
      otherWork,
    )),
    ...detail(deps.verifier.judgment.config),
  ];
}

async function runPlan(given: RunInput) {
  const { deps, project } = given;
  const teamKey = await teamKeyOf(deps.linear(), project);
  const input: RunInput = {
    ...given,
    next: withIdentifierCase(given.next, teamKey),
  };
  const { session, previous, next } = input;
  const { store } = deps;
  const api = deps.linear();
  const workspace = workspaceFor(deps, project.teamId);
  const managed = project.adoption === "managed";
  const decide = new Decider(managed, input.overwrite);
  const dry = input.dryRun;
  const team = { key: teamKey };
  const mapped = new Map(
    (input.journal?.tasks ?? []).map((task) => [task.key, task]),
  );
  const openIssueIds = new Set(
    store
      .openWork(project.key)
      .filter((work) => OPEN_WORK.has(work.status))
      .map((work) => work.issueId),
  );
  const { external, order } = await validatePlan(next, {
    workspace,
    api,
    project,
    teamKey: team.key,
    mapped,
    previous,
    openIssueIds,
  });

  // Plan-time checks run before any write: until
  // the plan has once passed readiness (`readyAt`), a plan write writes
  // nothing until every problem is fixed or accepted; later plan writes
  // apply and post their warnings.
  const gated = !isReady(project);
  const pending = await planTimeEntries(input, mapped);
  const warnings = entryProblems(pending).filter(
    (problem) => problem.outcome !== "unavailable",
  );
  let readiness:
    | {
        readonly blocking: readonly PlanProblem[];
        readonly accepted: readonly PlanProblem[];
      }
    | undefined;
  if (gated) {
    const linearBefore =
      project.linearProjectId === ""
        ? null
        : await api.project(project.linearProjectId);
    const checked = applyAccept(
      [
        ...completenessProblems(
          completenessOf(next.record, next.tasks, linearBefore, managed),
        ),
        ...entryProblems(pending),
        ...(deps.verifier === undefined && !deps.checksOff
          ? [JUDGMENT_UNAVAILABLE]
          : []),
      ],
      input.accept,
    );
    readiness = checked;
    if (checked.blocking.length > 0 && !dry)
      return {
        ready: false,
        plan_revision: project.planRevision,
        problems: checked.blocking,
        ...(checked.accepted.length === 0
          ? {}
          : { accepted: checked.accepted.map((problem) => problem.id) }),
        message: NOT_READY_MESSAGE,
      };
  }
  // This write passes readiness for the whole plan when it was gated and
  // every problem is fixed or accepted; the time goes to the project row and
  // the machine map, so every machine stops gating from here on.
  const readyAt = isReady(project)
    ? (project.readyAt ?? null)
    : readiness !== undefined && readiness.blocking.length === 0
      ? deps.now().toISOString()
      : null;
  const readyMark = readyMarkOf(readyAt);
  const viewer = await workspace.viewer();
  const { all: states, resolved } = await workspace.states();
  const statuses = await api.projectStatuses();
  const prevTasks = new Map(
    (previous?.tasks ?? []).map((task) => [task.key, task]),
  );
  const prevRecord = previous?.record;
  const placeholder = (key: string) => `(new) ${key}`;

  // Labels: groups, their labels, ungrouped labels, project labels.
  const labelIds = new Map<string, string>();
  for (const group of next.record.label_groups) {
    let groupLabel = await workspace.findLabel(group.name);
    if (groupLabel === undefined) {
      decide.record({
        object: "label_group",
        key: group.name,
        action: "create",
      });
      if (!dry)
        groupLabel = await workspace.ensureLabel(
          group.name,
          group.color ?? "#6b6f76",
          {
            isGroup: true,
            groupType: "singleSelect",
            ...(group.description === undefined
              ? {}
              : { description: group.description }),
          },
        );
    }
    for (const label of group.labels) {
      let found = await workspace.findLabel(label.name);
      if (found === undefined) {
        decide.record({ object: "label", key: label.name, action: "create" });
        if (!dry && groupLabel !== undefined)
          found = await workspace.ensureLabel(
            label.name,
            label.color ?? group.color ?? "#6b6f76",
            {
              parentId: groupLabel.id,
              ...(label.description === undefined
                ? {}
                : { description: label.description }),
            },
          );
      }
      labelIds.set(
        label.name.toLowerCase(),
        found?.id ?? placeholder(label.name),
      );
    }
  }
  for (const label of next.record.labels) {
    let found = await workspace.findLabel(label.name);
    if (found === undefined) {
      decide.record({ object: "label", key: label.name, action: "create" });
      if (!dry)
        found = await workspace.ensureLabel(
          label.name,
          label.color ?? "#6b6f76",
          {
            ...(label.description === undefined
              ? {}
              : { description: label.description }),
          },
        );
    }
    labelIds.set(
      label.name.toLowerCase(),
      found?.id ?? placeholder(label.name),
    );
  }
  const projectLabelIds: string[] = [];
  for (const label of next.record.project.labels ?? []) {
    const existing = (await workspace.projectLabels()).find(
      (entry) => entry.name.toLowerCase() === label.name.toLowerCase(),
    );
    if (existing !== undefined) {
      projectLabelIds.push(existing.id);
      continue;
    }
    decide.record({
      object: "project_label",
      key: label.name,
      action: "create",
    });
    if (!dry) {
      const created = await workspace.ensureProjectLabel(
        label.name,
        label.color,
        {
          ...(label.description === undefined
            ? {}
            : { description: label.description }),
        },
      );
      projectLabelIds.push(created.id);
    }
  }

  // The project.
  const fields = next.record.project;
  const prevFields = prevRecord?.project;
  let linearProject: Project | null =
    project.linearProjectId === ""
      ? null
      : await api.project(project.linearProjectId);
  if (project.linearProjectId !== "" && linearProject === null)
    throw new BoardError(
      "not_found",
      `The Linear project of ${project.key} was deleted or trashed.`,
    );
  const statusId = statusIdFor(statuses, fields.status);
  if (linearProject === null) {
    decide.record({ object: "project", key: fields.name, action: "create" });
    if (!dry) {
      const id = stableId("project", project.key, project.createdAt);
      const create: Parameters<LinearApi["createProject"]>[0] = {
        id,
        name: fields.name,
        teamIds: [project.teamId],
        leadId: viewer.id,
        memberIds: [viewer.id],
        ...(fields.icon === undefined ? {} : { icon: fields.icon }),
        ...(fields.color === undefined ? {} : { color: fields.color }),
        ...(fields.summary === undefined
          ? {}
          : { description: fields.summary }),
        ...(fields.overview === undefined ? {} : { content: fields.overview }),
        ...(statusId === undefined ? {} : { statusId }),
        ...(fields.priority === undefined ? {} : { priority: fields.priority }),
        ...(projectLabelIds.length === 0 ? {} : { labelIds: projectLabelIds }),
        ...(fields.start_date === undefined
          ? {}
          : { startDate: fields.start_date }),
        ...(fields.start_resolution === undefined
          ? {}
          : { startDateResolution: fields.start_resolution }),
        ...(fields.target_date === undefined
          ? {}
          : { targetDate: fields.target_date }),
        ...(fields.target_resolution === undefined
          ? {}
          : { targetDateResolution: fields.target_resolution }),
      };
      linearProject = await createOr(
        () => api.createProject(create),
        async () => (await api.project(id)) ?? undefined,
      );
    }
  } else {
    const current = linearProject;
    const prevStatus = statusIdFor(statuses, prevFields?.status);
    const wanted = decide.fields("project", current.name, [
      {
        field: "name",
        current: current.name,
        desired: fields.name,
        previous: prevFields?.name,
      },
      {
        field: "icon",
        current: current.icon,
        desired: fields.icon,
        previous: prevFields?.icon,
      },
      {
        field: "color",
        current: current.color,
        desired: fields.color,
        previous: prevFields?.color,
      },
      {
        field: "description",
        current: current.description,
        desired: fields.summary,
        previous: prevFields?.summary,
      },
      {
        field: "content",
        current: current.content,
        desired: fields.overview,
        previous: prevFields?.overview,
      },
      {
        field: "statusId",
        current: current.statusId,
        desired: statusId,
        previous: prevStatus,
      },
      {
        field: "priority",
        current: current.priority,
        desired: fields.priority,
        previous: prevFields?.priority,
      },
      {
        field: "startDate",
        current: current.startDate,
        desired: fields.start_date,
        previous: prevFields?.start_date,
      },
      {
        field: "targetDate",
        current: current.targetDate,
        desired: fields.target_date,
        previous: prevFields?.target_date,
      },
    ]);
    const addLabels = projectLabelIds.filter(
      (id) => !current.labelIds.includes(id),
    );
    if (addLabels.length > 0)
      wanted.set("labelIds", [...current.labelIds, ...addLabels]);
    if (wanted.has("startDate") && fields.start_resolution !== undefined)
      wanted.set("startDateResolution", fields.start_resolution);
    if (wanted.has("targetDate") && fields.target_resolution !== undefined)
      wanted.set("targetDateResolution", fields.target_resolution);
    if (wanted.size > 0) {
      decide.record({
        object: "project",
        key: current.name,
        action: "update",
        fields: changeFields(wanted, { ...current }),
      });
      if (!dry) {
        const patch: Partial<ProjectFields> = projectPatch(wanted);
        linearProject = await api.updateProject(current.id, patch);
      }
    }
  }
  const linearProjectId = linearProject?.id ?? placeholder("project");

  // Milestones.
  const milestoneIds: Record<string, string> = {
    ...(prevRecord?.milestone_ids ?? {}),
  };
  const existingMilestones: readonly Milestone[] =
    linearProject === null ? [] : await api.milestones(linearProject.id);
  for (const [index, milestone] of next.record.milestones.entries()) {
    const name = milestoneName(milestone);
    const prev = prevRecord?.milestones.find(
      (entry) => entry.code === milestone.code,
    );
    const found =
      existingMilestones.find(
        (entry) => entry.id === milestoneIds[milestone.code],
      ) ??
      existingMilestones.find((entry) => entry.name === name) ??
      existingMilestones.find((entry) =>
        entry.name.startsWith(`${milestone.code} · `),
      );
    if (found === undefined) {
      decide.record({
        object: "milestone",
        key: milestone.code,
        action: "create",
      });
      if (dry || linearProject === null) {
        milestoneIds[milestone.code] = placeholder(milestone.code);
        continue;
      }
      const id = stableId(linearProject.id, "milestone", milestone.code);
      const projectId = linearProject.id;
      const created = await createOr(
        () =>
          api.createMilestone({
            id,
            projectId,
            name,
            sortOrder: (index + 1) * 1000,
            ...(milestone.description === undefined
              ? {}
              : { description: milestone.description }),
            ...(milestone.target_date === undefined
              ? {}
              : { targetDate: milestone.target_date }),
          }),
        async () =>
          (await api.milestones(projectId)).find((entry) => entry.id === id),
      );
      milestoneIds[milestone.code] = created.id;
      continue;
    }
    milestoneIds[milestone.code] = found.id;
    const wanted = decide.fields("milestones", milestone.code, [
      {
        field: "name",
        current: found.name,
        desired: name,
        previous: prev === undefined ? undefined : milestoneName(prev),
      },
      {
        field: "description",
        current: found.description,
        desired: milestone.description,
        previous: prev?.description,
      },
      {
        field: "targetDate",
        current: found.targetDate,
        desired: milestone.target_date,
        previous: prev?.target_date,
      },
    ]);
    if (wanted.size > 0) {
      decide.record({
        object: "milestone",
        key: milestone.code,
        action: "update",
        fields: changeFields(wanted, { ...found }),
      });
      if (!dry)
        await api.updateMilestone(found.id, {
          ...(wanted.has("name") ? { name } : {}),
          ...(wanted.has("description") && milestone.description !== undefined
            ? { description: milestone.description }
            : {}),
          ...(wanted.has("targetDate") && milestone.target_date !== undefined
            ? { targetDate: milestone.target_date }
            : {}),
        });
    }
  }

  // Documents the plan carries, and links.
  const documents: readonly Document[] =
    linearProject === null ? [] : await api.documents(linearProject.id);
  for (const document of next.record.documents) {
    const prev = prevRecord?.documents.find(
      (entry) => entry.title === document.title,
    );
    const found = documents.find(
      (entry) => entry.title.toLowerCase() === document.title.toLowerCase(),
    );
    if (found === undefined) {
      decide.record({
        object: "document",
        key: document.title,
        action: "create",
      });
      if (!dry && linearProject !== null) {
        const id = stableId(linearProject.id, "document", document.title);
        const projectId = linearProject.id;
        await createOr(
          () =>
            api.createDocument({
              id,
              projectId,
              title: document.title,
              content: document.content,
              ...(document.icon === undefined ? {} : { icon: document.icon }),
              ...(document.color === undefined
                ? {}
                : { color: document.color }),
            }),
          async () =>
            (await api.documents(projectId)).find((entry) => entry.id === id),
        );
      }
      continue;
    }
    const wanted = decide.fields("documents", document.title, [
      {
        field: "content",
        current: found.content,
        desired: document.content,
        previous: prev?.content,
      },
      {
        field: "icon",
        current: found.icon,
        desired: document.icon,
        previous: prev?.icon,
      },
      {
        field: "color",
        current: found.color,
        desired: document.color,
        previous: prev?.color,
      },
    ]);
    if (wanted.size > 0) {
      decide.record({
        object: "document",
        key: document.title,
        action: "update",
        fields: changeFields(wanted, { ...found }),
      });
      if (!dry)
        await api.updateDocument(found.id, {
          ...(wanted.has("content") ? { content: document.content } : {}),
          ...(wanted.has("icon") && document.icon !== undefined
            ? { icon: document.icon }
            : {}),
          ...(wanted.has("color") && document.color !== undefined
            ? { color: document.color }
            : {}),
        });
    }
  }
  const links: readonly ExternalLink[] =
    linearProject === null ? [] : await api.externalLinks(linearProject.id);
  for (const link of next.record.links) {
    if (links.some((entry) => entry.url === link.url)) continue;
    decide.record({ object: "link", key: link.url, action: "create" });
    if (!dry && linearProject !== null) {
      const id = stableId(linearProject.id, "link", link.url);
      const projectId = linearProject.id;
      await createOr(
        () =>
          api.createExternalLink(projectId, {
            id,
            label: link.label,
            url: link.url,
          }),
        async () =>
          (await api.externalLinks(projectId)).find((entry) => entry.id === id),
      );
    }
  }

  // Each label's single-select group, by group name: plan groups, and the
  // parent groups of existing labels.
  const groupKeyOf = new Map<string, string>();
  const labelNameOf = new Map<string, string>();
  const known = await workspace.labels();
  const names = new Map(known.map((label) => [label.id, label.name]));
  for (const label of known) {
    labelNameOf.set(label.id, label.name);
    const parent =
      label.parentId === null ? undefined : names.get(label.parentId);
    if (parent !== undefined) groupKeyOf.set(label.id, parent.toLowerCase());
  }
  // A plan group names the group of the labels it creates; a label that
  // already sits in a Linear group keeps that group.
  for (const group of next.record.label_groups)
    for (const label of group.labels) {
      const id = labelIds.get(label.name.toLowerCase());
      if (id === undefined) continue;
      if (!groupKeyOf.has(id)) groupKeyOf.set(id, group.name.toLowerCase());
      if (!labelNameOf.has(id)) labelNameOf.set(id, label.name);
    }

  // Issues, dependencies first.
  const issueByKey = new Map<string, Issue>();
  for (const [key, task] of mapped) {
    const issue = await api.issue(task.issueId);
    if (issue !== null) issueByKey.set(key, issue);
  }
  for (const [ref, issue] of external)
    if (next.tasks.some((task) => task.key.toUpperCase() === ref))
      issueByKey.set(issue.identifier, issue);
  const refIssue = (ref: string): Issue | undefined =>
    issueByKey.get(ref) ?? external.get(ref.toUpperCase());
  const refIdentifier = (ref: string): string =>
    refIssue(ref)?.identifier ?? placeholder(ref);
  const refTitle = (ref: string): string => {
    const task = next.tasks.find((entry) => entry.key === ref);
    if (task !== undefined) return task.title;
    const issue = refIssue(ref);
    return issue === undefined ? "" : plainTitle(issue.title, ref);
  };
  const stateFor = (type: WorkflowState["type"]) =>
    [...states]
      .filter((state) => state.type === type)
      .sort((a, b) => a.position - b.position)[0];
  const backlog = stateFor("backlog") ?? stateFor("unstarted");
  const touched: Issue[] = [];
  const journalTasks: JournalTask[] = [];
  for (const task of order) {
    const prev = prevTasks.get(task.key);
    const existing = issueByKey.get(task.key);
    const dependencies =
      task.depends_on === undefined
        ? undefined
        : task.depends_on.map((ref) => ({
            identifier: refIdentifier(ref),
            title: refTitle(ref),
          }));
    const sections = desiredSections(task, dependencies);
    const milestoneId =
      task.milestone === undefined ? undefined : milestoneIds[task.milestone];
    const parentId =
      task.parent === undefined
        ? undefined
        : (refIssue(task.parent)?.id ?? placeholder(task.parent));
    const desiredLabels = (task.labels ?? []).map(
      (name) => labelIds.get(name.toLowerCase()) ?? placeholder(name),
    );
    if (existing === undefined) {
      decide.record({ object: "issue", key: task.key, action: "create" });
      if (dry || linearProject === null) continue;
      const resolvedLabels: string[] = [];
      for (const name of task.labels ?? []) {
        const id =
          labelIds.get(name.toLowerCase()) ??
          (await workspace.findLabel(name))?.id;
        if (id !== undefined) resolvedLabels.push(id);
      }
      const id = stableId(linearProject.id, "issue", task.key);
      const stateId =
        task.status === "cancelled" ? resolved.canceled.id : backlog?.id;
      const created = await createOr(
        () =>
          api.createIssue({
            id,
            teamId: project.teamId,
            projectId: linearProject.id,
            title: issueTitle(task),
            description: renderDescription(sections),
            assigneeId: viewer.id,
            ...(stateId === undefined ? {} : { stateId }),
            ...(task.priority === undefined ? {} : { priority: task.priority }),
            ...(task.estimate === undefined ? {} : { estimate: task.estimate }),
            ...(resolvedLabels.length === 0
              ? {}
              : { labelIds: resolvedLabels }),
            ...(milestoneId === undefined
              ? {}
              : { projectMilestoneId: milestoneId }),
            ...(parentId === undefined ? {} : { parentId }),
            ...(task.due_date === undefined ? {} : { dueDate: task.due_date }),
          }),
        async () => (await api.issue(id)) ?? undefined,
      );
      issueByKey.set(task.key, created);
      touched.push(created);
      journalTasks.push({
        key: task.key,
        issueId: created.id,
        identifier: created.identifier,
        title: created.title,
        definition: { ...task },
      });
      continue;
    }
    // An existing issue: tool-created (in the plan) or adopted.
    // Created mode owns the `KEY: title` it wrote. Managed mode keeps the
    // titles of issues that existed before adoption unless the request names
    // the title in overwrite (or MANAGED_PREFIXES_EXISTING_TITLES is on).
    const prefixed = existing.title.startsWith(`${task.key}: `);
    const desiredTitle = managed
      ? prefixed ||
        MANAGED_PREFIXES_EXISTING_TITLES ||
        input.overwrite.includes(`tasks.${task.key}.title`)
        ? issueTitle(task)
        : undefined
      : prev === undefined && !mapped.has(task.key)
        ? undefined
        : issueTitle(task);
    const parsed = parseDescription(existing.description);
    const prevSections =
      prev === undefined
        ? undefined
        : desiredSections(
            prev,
            prev.depends_on?.map((ref) => ({
              identifier: refIdentifier(ref),
              title: refTitle(ref),
            })),
          );
    const sectionWrites: TaskSections = {};
    const sectionChanges: Record<string, { old: unknown; new: unknown }> = {};
    for (const field of SECTION_FIELDS) {
      const desired = sectionValue(sections, field);
      const current = sectionValue(parsed.sections, field);
      const previousValue =
        prevSections === undefined
          ? undefined
          : sectionValue(prevSections, field);
      const path = `tasks.${task.key}.${field}`;
      if (decide.wants(path, current, desired, previousValue)) {
        Object.assign(sectionWrites, { [field]: sections[field] });
        sectionChanges[field] = { old: current ?? null, new: desired };
      } else if (
        managed &&
        desired !== undefined &&
        !isDeepStrictEqual(current, desired)
      )
        decide.skipped.push({
          object: "tasks",
          key: task.key,
          field,
          old: current ?? null,
          new: desired,
        });
    }
    // A field the plan had and dropped is cleared: in created mode always,
    // in managed mode only when overwrite names it.
    const cleared = <T>(
      field: string,
      desired: T | undefined,
      had: unknown,
      empty: T | null,
    ): T | null | undefined =>
      desired === undefined &&
      had !== undefined &&
      (!managed || input.overwrite.includes(`tasks.${task.key}.${field}`))
        ? empty
        : desired;
    const wanted = decide.fields("tasks", task.key, [
      {
        field: "title",
        current: existing.title,
        desired: desiredTitle,
        previous: prev === undefined ? undefined : issueTitle(prev),
      },
      {
        field: "priority",
        current: existing.priority,
        desired: cleared("priority", task.priority, prev?.priority, 0),
        previous: prev?.priority,
      },
      {
        field: "estimate",
        current: existing.estimate,
        desired: cleared("estimate", task.estimate, prev?.estimate, null),
        previous: prev?.estimate,
      },
      {
        field: "dueDate",
        current: existing.dueDate,
        desired: cleared("dueDate", task.due_date, prev?.due_date, null),
        previous: prev?.due_date,
      },
      {
        field: "projectMilestoneId",
        current: existing.projectMilestoneId,
        desired: cleared(
          "projectMilestoneId",
          milestoneId,
          prev?.milestone,
          null,
        ),
        previous:
          prev?.milestone === undefined
            ? undefined
            : milestoneIds[prev.milestone],
      },
      {
        field: "parentId",
        current: existing.parentId,
        desired: cleared("parentId", parentId, prev?.parent, null),
        previous:
          prev?.parent === undefined ? undefined : refIssue(prev.parent)?.id,
      },
    ]);
    const prevLabelIds = (prev?.labels ?? [])
      .map((name) => labelIds.get(name.toLowerCase()))
      .filter((id): id is string => id !== undefined);
    const dropLabels = managed
      ? []
      : prevLabelIds.filter(
          (id) => !desiredLabels.includes(id) && existing.labelIds.includes(id),
        );
    // One label per group: a label already set in the group is a set value
    // in managed mode, replaced only when overwrite names the labels.
    const addLabels: string[] = [];
    const replaceLabels = input.overwrite.includes(`tasks.${task.key}.labels`);
    for (const id of desiredLabels) {
      if (existing.labelIds.includes(id)) continue;
      const group = groupKeyOf.get(id);
      const sameGroup =
        group === undefined
          ? []
          : existing.labelIds.filter(
              (other) =>
                other !== id &&
                !dropLabels.includes(other) &&
                groupKeyOf.get(other) === group,
            );
      if (sameGroup.length > 0 && managed && !replaceLabels) {
        decide.skipped.push({
          object: "tasks",
          key: task.key,
          field: `labels:${group ?? ""}`,
          old: sameGroup.map((other) => labelNameOf.get(other) ?? other),
          new: labelNameOf.get(id) ?? id,
        });
        continue;
      }
      dropLabels.push(...sameGroup);
      addLabels.push(id);
    }
    // Labels change by delta (addLabel / removeLabel), never by sending a
    // full set, so a label someone added meanwhile (a claim's vc:claimed and
    // agent label among them) is never dropped; reserved vc:* and agent:*
    // labels are never touched by a plan write.
    const isReservedId = (id: string) =>
      isReservedLabel(labelNameOf.get(id) ?? names.get(id) ?? "");
    const labelAdds = addLabels.filter((id) => !isReservedId(id));
    const labelDrops = [...new Set(dropLabels)].filter(
      (id) => !isReservedId(id),
    );
    const labelFields =
      labelAdds.length === 0 && labelDrops.length === 0
        ? {}
        : {
            labelIds: {
              old: existing.labelIds.map((id) => labelNameOf.get(id) ?? id),
              new: [
                ...existing.labelIds.filter((id) => !labelDrops.includes(id)),
                ...labelAdds,
              ].map((id) => labelNameOf.get(id) ?? id),
            },
          };
    // A plan moves states only in created mode; managed mode moves an
    // issue's state only through claims.
    const cancel =
      task.status === "cancelled" &&
      existing.stateType !== "canceled" &&
      existing.stateType !== "completed";
    const restore =
      task.status !== "cancelled" &&
      prev?.status === "cancelled" &&
      existing.stateType === "canceled" &&
      backlog !== undefined;
    if (managed && (cancel || restore))
      decide.skipped.push({
        object: "tasks",
        key: task.key,
        field: "state",
        old: existing.stateName,
        new: cancel ? resolved.canceled.name : (backlog?.name ?? null),
      });
    else if (cancel) wanted.set("stateId", resolved.canceled.id);
    else if (restore && backlog !== undefined)
      wanted.set("stateId", backlog.id);
    const description =
      Object.keys(sectionWrites).length === 0
        ? undefined
        : renderDescription(sectionWrites, existing.description);
    const labelsChange = Object.keys(labelFields).length > 0;
    if (wanted.size > 0 || description !== undefined || labelsChange) {
      decide.record({
        object: "issue",
        key: task.key,
        action: "update",
        fields: {
          ...changeFields(wanted, { ...existing }),
          ...labelFields,
          ...sectionChanges,
        },
      });
      if (!dry) {
        const patch: IssueFields = {
          ...issuePatch(wanted),
          ...(description === undefined ? {} : { description }),
        };
        let updated =
          Object.keys(patch).length === 0
            ? existing
            : await api.updateIssue(existing.id, patch);
        for (const id of labelDrops)
          await removeLabelIfPresent(api, existing.id, id);
        for (const id of labelAdds) await api.addLabel(existing.id, id);
        if (labelsChange) updated = (await api.issue(existing.id)) ?? updated;
        issueByKey.set(task.key, updated);
        touched.push(updated);
      }
    }
    const final = issueByKey.get(task.key) ?? existing;
    journalTasks.push({
      key: task.key,
      issueId: final.id,
      identifier: final.identifier,
      title: final.title,
      definition: { ...task },
    });
  }

  // Relations: `blocks` for dependencies, `related` for supersedes; in
  // managed mode also for dependencies already written in `Depends on`.
  for (const task of next.tasks) {
    const issue = issueByKey.get(task.key);
    const prev = prevTasks.get(task.key);
    const wantedBlocks = new Set(
      (task.depends_on ?? []).map(
        (ref) => refIssue(ref)?.id ?? placeholder(ref),
      ),
    );
    if (managed && issue !== undefined)
      for (const dep of parseDescription(issue.description).sections
        .depends_on ?? []) {
        const found =
          issueByKey.get(dep.identifier) ??
          external.get(dep.identifier.toUpperCase());
        const resolvedDep =
          found ??
          [...issueByKey.values()].find(
            (entry) => entry.identifier === dep.identifier,
          );
        if (resolvedDep !== undefined) wantedBlocks.add(resolvedDep.id);
      }
    const wantedRelated = new Set(
      (task.supersedes ?? []).map(
        (ref) => refIssue(ref)?.id ?? placeholder(ref),
      ),
    );
    if (
      wantedBlocks.size === 0 &&
      wantedRelated.size === 0 &&
      prev?.depends_on === undefined
    )
      continue;
    const relations =
      issue === undefined || dry ? [] : await api.relations(issue.id);
    for (const blocker of wantedBlocks) {
      if (
        relations.some(
          (relation) =>
            relation.type === "blocks" &&
            relation.issueId === blocker &&
            relation.relatedIssueId === issue?.id,
        )
      )
        continue;
      decide.record({
        object: "relation",
        key: `${blocker} blocks ${task.key}`,
        action: "create",
      });
      if (!dry && issue !== undefined) {
        const id = stableId(issue.id, "blocks", blocker);
        await createOr(
          () =>
            api.createRelation({
              id,
              type: "blocks",
              issueId: blocker,
              relatedIssueId: issue.id,
            }),
          async () =>
            (await api.relations(issue.id)).find((entry) => entry.id === id),
        );
      }
    }
    for (const old of wantedRelated) {
      if (
        relations.some(
          (relation) =>
            relation.type === "related" &&
            ((relation.issueId === old &&
              relation.relatedIssueId === issue?.id) ||
              (relation.relatedIssueId === old &&
                relation.issueId === issue?.id)),
        )
      )
        continue;
      decide.record({
        object: "relation",
        key: `${task.key} related ${old}`,
        action: "create",
      });
      if (!dry && issue !== undefined) {
        const id = stableId(issue.id, "related", old);
        await createOr(
          () =>
            api.createRelation({
              id,
              type: "related",
              issueId: issue.id,
              relatedIssueId: old,
            }),
          async () =>
            (await api.relations(issue.id)).find((entry) => entry.id === id),
        );
      }
    }
    if (!managed && !dry && issue !== undefined)
      for (const ref of prev?.depends_on ?? []) {
        const removedId = refIssue(ref)?.id;
        if (removedId === undefined || wantedBlocks.has(removedId)) continue;
        const stale = relations.find(
          (relation) =>
            relation.type === "blocks" &&
            relation.issueId === removedId &&
            relation.relatedIssueId === issue.id,
        );
        if (stale !== undefined) await api.deleteRelation(stale.id);
      }
  }

  // The tool's own documents.
  const revision = project.planRevision + 1;
  const policyText = (policy: ProjectPolicy | undefined) =>
    `${managed ? `${MANAGED_ADOPTION_LINE}\n\n` : ""}${renderPolicyDocument(policy ?? {})}`;
  let policyDocumentId = project.policyDocumentId;
  const policyChanged =
    !isDeepStrictEqual(
      prevRecord?.policy ?? null,
      next.record.policy ?? null,
    ) || policyDocumentId === null;
  if (next.record.policy !== undefined || managed) {
    const found =
      documents.find((entry) => entry.id === policyDocumentId) ??
      documents.find((entry) => entry.title === POLICY_DOCUMENT_TITLE);
    if (found === undefined) {
      decide.record({
        object: "document",
        key: POLICY_DOCUMENT_TITLE,
        action: "create",
      });
      if (!dry && linearProject !== null) {
        const id = stableId(
          linearProject.id,
          "document",
          POLICY_DOCUMENT_TITLE,
        );
        const created = await createToolDocument(api, {
          id,
          projectId: linearProject.id,
          title: POLICY_DOCUMENT_TITLE,
          icon: POLICY_DOCUMENT_ICON,
          content: policyText(next.record.policy),
        });
        policyDocumentId = created.id;
      }
    } else {
      policyDocumentId = found.id;
      if (policyChanged && found.content !== policyText(next.record.policy)) {
        decide.record({
          object: "document",
          key: POLICY_DOCUMENT_TITLE,
          action: "update",
        });
        if (!dry)
          await api.updateDocument(found.id, {
            content: policyText(next.record.policy),
          });
      }
    }
  }
  const taskMap: Record<string, string> = Object.fromEntries(
    journalTasks.map((task) => [task.key, task.identifier]),
  );
  const planWarnings = gated
    ? []
    : warnings
        .filter((warning) => warning.key === undefined)
        .map(
          (warning) => `${warning.check} ${warning.outcome}: ${warning.reason}`,
        );
  const planContent = renderPlanDocument(
    {
      revision,
      origin: originOf(project),
      ...readyMark,
      tasks: taskMap,
      milestones: Object.fromEntries(
        Object.entries(milestoneIds).filter(
          ([, id]) => !id.startsWith("(new)"),
        ),
      ),
    },
    journalTasks.map((task) => {
      const definition = next.tasks.find((entry) => entry.key === task.key);
      return {
        key: task.key,
        identifier: task.identifier,
        title: definition?.title ?? task.title,
        ...(definition?.milestone === undefined
          ? {}
          : { milestone: definition.milestone }),
        ...(definition?.depends_on === undefined ||
        definition.depends_on.length === 0
          ? {}
          : { dependsOn: definition.depends_on }),
      };
    }),
    next.record.milestones.map((milestone) => ({
      code: milestone.code,
      name: milestone.name,
    })),
    planWarnings,
  );
  let planDocumentId = project.planDocumentId;
  const planDoc =
    documents.find((entry) => entry.id === planDocumentId) ??
    documents.find((entry) => entry.title === PLAN_DOCUMENT_TITLE);
  decide.record({
    object: "document",
    key: PLAN_DOCUMENT_TITLE,
    action: planDoc === undefined ? "create" : "update",
  });
  let finalRevision = revision;
  let finalTasks: readonly JournalTask[] = journalTasks;
  let mergedWith: { revision: number; keys: string[] } | undefined;
  const mergedUrls = new Map<string, string>();
  const knownMilestones = Object.fromEntries(
    Object.entries(milestoneIds).filter(([, id]) => !id.startsWith("(new)")),
  );
  const renderMap = (map: PlanMap, tasks: readonly JournalTask[]) =>
    renderPlanDocument(
      map,
      tasks.map((task) => {
        const definition = next.tasks.find((entry) => entry.key === task.key);
        return {
          key: task.key,
          identifier: task.identifier,
          title: definition?.title ?? task.title,
          ...(definition?.milestone === undefined
            ? {}
            : { milestone: definition.milestone }),
        };
      }),
      next.record.milestones.map((milestone) => ({
        code: milestone.code,
        name: milestone.name,
      })),
      planWarnings,
    );
  if (!dry && linearProject !== null) {
    const projectId = linearProject.id;
    // Another coordinator may have written this revision since the check.
    let other =
      planDoc === undefined
        ? undefined
        : await foreignMap(api, projectId, planDoc.id, revision, journalTasks);
    if (planDoc === undefined) {
      const id = stableId(projectId, "document", PLAN_DOCUMENT_TITLE);
      const created = await createToolDocument(api, {
        id,
        projectId,
        title: PLAN_DOCUMENT_TITLE,
        icon: PLAN_DOCUMENT_ICON,
        content: planContent,
      });
      planDocumentId = created.id;
    } else {
      planDocumentId = planDoc.id;
      if (other === undefined) {
        await api.updateDocument(planDoc.id, { content: planContent });
        other = await foreignMap(
          api,
          projectId,
          planDoc.id,
          revision,
          journalTasks,
        );
      }
    }
    const known = journalKeys(store, project);
    if (other !== undefined && planDocumentId !== null) {
      const merged = await mergePlanMaps(
        api,
        {
          projectId,
          documentId: planDocumentId,
          revision,
          tasks: journalTasks,
          origin: originOf(project),
          readyAt,
          milestones: knownMilestones,
          render: renderMap,
          known,
        },
        other,
      );
      finalRevision = merged.revision;
      finalTasks = merged.tasks;
      for (const [key, url] of merged.urls) mergedUrls.set(key, url);
      mergedWith = { revision: other.revision, keys: merged.keys };
    } else if (planDocumentId !== null) {
      // No other map now, but an earlier race may have dropped a key: issues
      // of the project that a known key names, or that the tool created for
      // a plan task, and that this map misses, come back at the next revision.
      const orphans = await findOrphans(
        api,
        projectId,
        mappedBy(finalTasks),
        known,
        true,
      );
      if (orphans.length > 0) {
        const tasks = [
          ...finalTasks,
          ...orphans.map(({ key, issue }) => journalTaskOf(key, issue)),
        ];
        const restored = finalRevision + 1;
        await api.updateDocument(planDocumentId, {
          content: renderMap(
            {
              revision: restored,
              origin: originOf(project),
              ...readyMark,
              tasks: taskIdentifiers(tasks),
              milestones: knownMilestones,
            },
            tasks,
          ),
        });
        for (const { key, issue } of orphans) mergedUrls.set(key, issue.url);
        mergedWith = {
          revision: finalRevision,
          keys: orphans.map(({ key }) => key),
        };
        finalRevision = restored;
        finalTasks = tasks;
      }
    }
  }
  if (input.update !== undefined) {
    decide.record({
      object: "project_update",
      key: input.update.health ?? "update",
      action: "create",
    });
    if (!dry && linearProject !== null) {
      const id = stableId(linearProject.id, "update", input.requestId);
      const projectId = linearProject.id;
      const update = input.update;
      await createOr(
        () =>
          api.createProjectUpdate({
            id,
            projectId,
            body: update.body,
            ...(update.health === undefined ? {} : { health: update.health }),
          }),
        async () =>
          (await api.projectUpdates(projectId)).find(
            (entry) => entry.id === id,
          ),
      );
    }
  }

  if (dry)
    return {
      dry_run: true,
      plan_revision: project.planRevision,
      ...(readiness === undefined
        ? {}
        : {
            ready: readiness.blocking.length === 0,
            problems: readiness.blocking,
            ...(readiness.accepted.length === 0
              ? {}
              : { accepted: readiness.accepted.map((problem) => problem.id) }),
          }),
      changes: decide.changes,
      skipped: decide.skipped,
      message:
        "Managed mode: nothing was written. Show these changes to the user; repeat the same request with confirm: true (and a new request_id) to apply them. Fields listed in skipped keep their values unless the request names them in overwrite.",
    };

  // Journal, project row, cache.
  const now = deps.now().toISOString();
  const record: PlanRecord = { ...next.record, milestone_ids: milestoneIds };
  const finalProject: ProjectRow = {
    ...project,
    linearProjectId,
    policyDocumentId,
    planDocumentId,
    planRevision: finalRevision,
    adoption: project.adoption === "pending" ? "managed" : project.adoption,
    managedConfirmed: managed ? true : project.managedConfirmed,
    dryRunHash: null,
    readyAt,
    policy:
      next.record.policy === undefined
        ? project.policy
        : { ...next.record.policy },
    url: linearProject?.url ?? project.url,
    name: linearProject?.name ?? project.name,
    updatedAt: now,
  };
  store.transaction(() => {
    store.putRevision({
      projectKey: project.key,
      revision: finalRevision,
      sessionId: session.id,
      createdAt: now,
      tasks: finalTasks,
      policy:
        next.record.policy === undefined ? null : { ...next.record.policy },
      plan: { ...record },
    });
    store.putProject(finalProject);
    if (touched.length > 0) store.cacheIssues(project.key, touched);
    touchSession(store, session, now);
  });

  // The plan-time checks, read before the write, are recorded now. After
  // the first publish their warnings also go to Linear: task warnings as
  // verdict comments on the task's issue (once per check, task and reason),
  // plan-wide ones in the plan document's Warnings section.
  let verification: VerificationItem[] = [];
  if (deps.verifier !== undefined && pending.length > 0) {
    const access = store.verificationAccess();
    verification = store.transaction(() => recordEntries(access, pending));
  }
  if (!gated && linearProject !== null) {
    const writer = new Writer(store, api, project.key);
    const author = authorOf(session);
    for (const warning of warnings) {
      if (warning.key === undefined) continue;
      const issue = issueByKey.get(warning.key);
      if (issue === undefined) continue;
      await writer.comment(
        issue.id,
        renderVerdictComment(
          author,
          warning.check,
          warning.outcome,
          warning.reason,
        ),
        stableId(
          linearProject.id,
          "plan-warning",
          warning.check,
          warning.key,
          warning.reason,
        ),
      );
    }
  }
  const completeness = completenessOf(
    record,
    next.tasks,
    linearProject === null ? null : await api.project(linearProject.id),
    project.adoption === "managed",
  );
  return {
    plan_revision: finalRevision,
    ...(readiness === undefined
      ? {}
      : {
          ready: true,
          ...(readiness.accepted.length === 0
            ? {}
            : { accepted: readiness.accepted.map((problem) => problem.id) }),
        }),
    ...(warnings.length === 0 || gated ? {} : { warnings }),
    project_url: linearProject?.url ?? null,
    linear_project_id: linearProjectId,
    task_map: Object.fromEntries(
      finalTasks.map((task) => {
        const issue = issueByKey.get(task.key);
        return [
          task.key,
          {
            identifier: task.identifier,
            issue_id: task.issueId,
            url: issue?.url ?? mergedUrls.get(task.key) ?? null,
          },
        ];
      }),
    ),
    ...(mergedWith === undefined ? {} : { merged_with: mergedWith }),
    completeness,
    ...(decide.skipped.length === 0 ? {} : { skipped: decide.skipped }),
    ...(verification.length === 0 ? {} : { verification }),
    sync: { pending: store.pendingCount() },
  };
}

/** The object's own fields whose value is not undefined, as plain JSON. */
function withoutUndefined(value: object): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(value)));
}

function projectPatch(
  values: ReadonlyMap<string, unknown>,
): Partial<ProjectFields> {
  const text = (key: string) => {
    const value = values.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: string) => {
    const value = values.get(key);
    return typeof value === "number" ? value : undefined;
  };
  const labels = values.get("labelIds");
  const resolution = (key: string) => {
    const parsed = z
      .enum(["month", "quarter", "halfYear", "year"])
      .safeParse(values.get(key));
    return parsed.success ? parsed.data : undefined;
  };
  const name = text("name");
  const icon = text("icon");
  const color = text("color");
  const description = text("description");
  const content = text("content");
  const statusId = text("statusId");
  const priority = number("priority");
  const startDate = text("startDate");
  const targetDate = text("targetDate");
  const startDateResolution = resolution("startDateResolution");
  const targetDateResolution = resolution("targetDateResolution");
  const labelIds = z.array(z.string()).safeParse(labels);
  return {
    ...(name === undefined ? {} : { name }),
    ...(icon === undefined ? {} : { icon }),
    ...(color === undefined ? {} : { color }),
    ...(description === undefined ? {} : { description }),
    ...(content === undefined ? {} : { content }),
    ...(statusId === undefined ? {} : { statusId }),
    ...(priority === undefined ? {} : { priority }),
    ...(startDate === undefined ? {} : { startDate }),
    ...(targetDate === undefined ? {} : { targetDate }),
    ...(startDateResolution === undefined ? {} : { startDateResolution }),
    ...(targetDateResolution === undefined ? {} : { targetDateResolution }),
    ...(labelIds.success && labels !== undefined
      ? { labelIds: labelIds.data }
      : {}),
  };
}

function issuePatch(values: ReadonlyMap<string, unknown>): IssueFields {
  const text = (key: string) => {
    const value = values.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: string) => {
    const value = values.get(key);
    return typeof value === "number" ? value : undefined;
  };
  /** A value to set, or null to clear a field the plan dropped. */
  const orNull = <T>(
    key: string,
    value: T | undefined,
  ): T | null | undefined =>
    values.has(key) && values.get(key) === null ? null : value;
  const title = text("title");
  const stateId = text("stateId");
  const priority = number("priority");
  const estimate = orNull("estimate", number("estimate"));
  const dueDate = orNull("dueDate", text("dueDate"));
  const projectMilestoneId = orNull(
    "projectMilestoneId",
    text("projectMilestoneId"),
  );
  const parentId = orNull("parentId", text("parentId"));
  const labelIds = z.array(z.string()).safeParse(values.get("labelIds"));
  return {
    ...(title === undefined ? {} : { title }),
    ...(stateId === undefined ? {} : { stateId }),
    ...(priority === undefined ? {} : { priority }),
    ...(estimate === undefined ? {} : { estimate }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(projectMilestoneId === undefined ? {} : { projectMilestoneId }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(labelIds.success && values.has("labelIds")
      ? { labelIds: labelIds.data }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

function planContext(
  deps: LedgerDeps,
  request: { project_id: string; session_id: string },
) {
  const project = requireProject(deps.store, projectKeyOf(request.project_id));
  const session = requireSession(
    deps.store,
    project,
    sessionIdOf(request.session_id),
  );
  if (project.adoption === "as_is")
    throw new BoardError(
      "forbidden",
      `Project ${project.key} is used as_is: vibecheck does not change its plan, issues or documents. To let it, the user can switch to managed with project_join adopt "managed".`,
      { mode: "as_is" },
    );
  requireAdopted(project);
  requireCoordinator(project, session);
  return { project, session };
}

/**
 * The project with its plan revision as Linear records it: the plan
 * document's machine map is read before every plan write, and a newer
 * revision there (another machine published) refreshes the local map.
 */
async function linearRevision(
  deps: LedgerDeps,
  project: ProjectRow,
): Promise<ProjectRow> {
  if (project.linearProjectId === "") return project;
  const documents = await deps.linear().documents(project.linearProjectId);
  const planDoc =
    documents.find((entry) => entry.id === project.planDocumentId) ??
    documents.find((entry) => entry.title === PLAN_DOCUMENT_TITLE);
  if (planDoc === undefined) return project;
  const map = parsePlanDocument(planDoc.content);
  if (map === null || map.revision < project.planRevision) return project;
  // The same revision with another map: another coordinator published it
  // at the same time, and Linear's copy is the one every machine reads.
  if (
    map.revision === project.planRevision &&
    isDeepStrictEqual(
      taskIdentifiers(currentRevision(deps.store, project)?.tasks ?? []),
      map.tasks,
    )
  )
    return project;
  return recoverPlanMap(
    deps,
    project,
    [planDoc, ...documents.filter((entry) => entry.id !== planDoc.id)],
    true,
  );
}

/**
 * Refreshes this machine's plan map from the plan document when Linear
 * records a newer revision, or this revision with another map (two
 * coordinators published at once). project_status calls it after the
 * reconciler, so plan_read shows what every machine reads.
 */
export async function refreshPlanMap(
  deps: LedgerDeps,
  project: ProjectRow,
): Promise<ProjectRow> {
  // Read before the refresh replaces this machine's map with Linear's.
  const known = journalKeys(deps.store, project);
  const current = await linearRevision(deps, project);
  return restoreDropped(deps, current, known);
}

setPlanMapRefresher(refreshPlanMap);

/**
 * Key to issue id from every plan revision this machine journaled, later
 * revisions winning.
 */
function journalKeys(
  store: LedgerDeps["store"],
  project: ProjectRow,
): Map<string, string> {
  const known = new Map<string, string>();
  for (let revision = 1; revision <= project.planRevision; revision++)
    for (const task of store.revision(project.key, revision)?.tasks ?? [])
      known.set(task.key, task.issueId);
  return known;
}

/** The keys and issue ids a map names. */
function mappedBy(tasks: readonly JournalTask[]) {
  return {
    keys: new Set(tasks.map((task) => task.key)),
    issueIds: new Set(tasks.map((task) => task.issueId)),
  };
}

/** A journal entry for an issue the tool finds by its key. */
function journalTaskOf(key: string, issue: Issue): JournalTask {
  return {
    key,
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    definition: { ...definitionFromIssue(issue, key) },
  };
}

/**
 * Issues of the project a plan map misses: one a key of this machine's
 * journals names (the same issue, still in the project, still titled
 * `<KEY>: ...`), and with `scanProject` one the tool created for a plan task
 * (titled `<KEY>: ...` with the client id a plan task's issue gets). A key
 * is never given another issue than its journal names, and an issue the map
 * already names is never added twice.
 */
async function findOrphans(
  api: LinearApi,
  projectId: string,
  mapped: {
    readonly keys: ReadonlySet<string>;
    readonly issueIds: ReadonlySet<string>;
  },
  known: ReadonlyMap<string, string>,
  scanProject: boolean,
): Promise<{ readonly key: string; readonly issue: Issue }[]> {
  const found: { key: string; issue: Issue }[] = [];
  const keys = new Set(mapped.keys);
  const ids = new Set(mapped.issueIds);
  const take = (key: string, issue: Issue) => {
    found.push({ key, issue });
    keys.add(key);
    ids.add(issue.id);
  };
  for (const [key, issueId] of known) {
    if (keys.has(key) || ids.has(issueId)) continue;
    let issue: Issue | null;
    try {
      issue = await api.issue(issueId);
    } catch (error) {
      if (isLinearError(error, "not_found")) continue;
      throw error;
    }
    if (
      issue === null ||
      issue.projectId !== projectId ||
      !issue.title.startsWith(`${key}: `)
    )
      continue;
    take(key, issue);
  }
  if (!scanProject) return found;
  let after: string | undefined;
  for (;;) {
    const page = await api.issues({ projectId }, after);
    for (const issue of page.nodes) {
      const key = /^([A-Za-z0-9._-]{1,64}): /u.exec(issue.title)?.[1];
      if (
        key === undefined ||
        keys.has(key) ||
        ids.has(issue.id) ||
        issue.id !== stableId(projectId, "issue", key)
      )
        continue;
      const journaled = known.get(key);
      if (journaled !== undefined && journaled !== issue.id) continue;
      take(key, issue);
    }
    if (page.next === null) return found;
    after = page.next;
  }
}

/**
 * After a refresh from Linear: keys this machine's journals know that
 * Linear's map dropped (two coordinators wrote one revision at once and the
 * later write missed the earlier one's new task) come back at the next
 * revision, written to the plan document and the journal. Nothing is read
 * from Linear unless the local map misses a known key.
 */
async function restoreDropped(
  deps: LedgerDeps,
  project: ProjectRow,
  known: ReadonlyMap<string, string>,
): Promise<ProjectRow> {
  if (project.linearProjectId === "") return project;
  const journal = currentRevision(deps.store, project);
  const local = mappedBy(journal?.tasks ?? []);
  const missing = [...known].filter(
    ([key, issueId]) => !local.keys.has(key) && !local.issueIds.has(issueId),
  );
  if (missing.length === 0) return project;
  const api = deps.linear();
  const documents = await api.documents(project.linearProjectId);
  const planDoc =
    documents.find((entry) => entry.id === project.planDocumentId) ??
    documents.find((entry) => entry.title === PLAN_DOCUMENT_TITLE);
  const map = planDoc === undefined ? null : parsePlanDocument(planDoc.content);
  // Another machine moved on meanwhile: the next refresh looks again.
  if (planDoc === undefined || map === null) return project;
  if (map.revision !== project.planRevision) return project;
  const orphans = await findOrphans(
    api,
    project.linearProjectId,
    {
      keys: new Set([...local.keys, ...Object.keys(map.tasks)]),
      issueIds: local.issueIds,
    },
    new Map(missing),
    false,
  );
  if (orphans.length === 0) return project;
  const added = orphans.map(({ key, issue }) => journalTaskOf(key, issue));
  const tasks = [...(journal?.tasks ?? []), ...added];
  const revision = map.revision + 1;
  await api.updateDocument(planDoc.id, {
    content: withPlanMap(
      planDoc.content,
      {
        ...map,
        revision,
        tasks: {
          ...map.tasks,
          ...Object.fromEntries(
            added.map((task) => [task.key, task.identifier]),
          ),
        },
      },
      added.map((task) => ({
        key: task.key,
        identifier: task.identifier,
        title: plainTitle(task.title, task.key),
      })),
    ),
  });
  const now = deps.now().toISOString();
  const restored: ProjectRow = {
    ...project,
    planRevision: revision,
    planDocumentId: planDoc.id,
    updatedAt: now,
  };
  deps.store.transaction(() => {
    deps.store.putRevision({
      projectKey: project.key,
      revision,
      sessionId: null,
      createdAt: now,
      tasks,
      policy: journal?.policy ?? null,
      plan: journal?.plan ?? null,
    });
    deps.store.putProject(restored);
  });
  return restored;
}

/** A journal's tasks as the machine map writes them: key to identifier. */
function taskIdentifiers(
  tasks: readonly JournalTask[],
): Record<string, string> {
  return Object.fromEntries(tasks.map((task) => [task.key, task.identifier]));
}

/**
 * The plan document's map when another coordinator's write differs from
 * the one this call made (or is about to make) at `revision`: the same
 * revision with another task map, or a newer revision that misses a key of
 * this call. Undefined when the document agrees.
 */
async function foreignMap(
  api: LinearApi,
  projectId: string,
  documentId: string,
  revision: number,
  ours: readonly JournalTask[],
): Promise<PlanMap | undefined> {
  const document = (await api.documents(projectId)).find(
    (entry) => entry.id === documentId,
  );
  const map =
    document === undefined ? null : parsePlanDocument(document.content);
  if (map === null || map.revision < revision) return undefined;
  const mine = taskIdentifiers(ours);
  if (map.revision === revision)
    return isDeepStrictEqual(map.tasks, mine) ? undefined : map;
  return Object.entries(mine).every(([key, id]) => map.tasks[key] === id)
    ? undefined
    : map;
}

/**
 * Merges this call's map with another coordinator's: this call's tasks, the
 * other map's keys this call does not have, and issues of the project
 * neither map names that the tool created for a plan task (titled
 * `<KEY>: ...` with the client id a plan task's issue gets). Writes the
 * result as the next revision and returns it with the keys it added.
 */
async function mergePlanMaps(
  api: LinearApi,
  input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly revision: number;
    readonly tasks: readonly JournalTask[];
    readonly origin: PlanOrigin;
    /** When the plan first passed readiness, if it has. */
    readonly readyAt: string | null;
    readonly milestones: Record<string, string>;
    readonly render: (map: PlanMap, tasks: readonly JournalTask[]) => string;
    /** Key to issue id, from every journal of this machine. */
    readonly known: ReadonlyMap<string, string>;
  },
  other: PlanMap,
): Promise<{
  readonly revision: number;
  readonly tasks: readonly JournalTask[];
  readonly keys: string[];
  readonly urls: Map<string, string>;
}> {
  const tasks = [...input.tasks];
  const keys: string[] = [];
  const urls = new Map<string, string>();
  const known = new Set(tasks.map((task) => task.key));
  const issues = new Set(tasks.map((task) => task.issueId));
  const add = (key: string, issue: Issue) => {
    tasks.push({
      key,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      definition: { ...definitionFromIssue(issue, key) },
    });
    known.add(key);
    issues.add(issue.id);
    keys.push(key);
    urls.set(key, issue.url);
  };
  for (const [key, identifier] of Object.entries(other.tasks)) {
    if (known.has(key)) continue;
    const issue = await api.issue(identifier);
    if (
      issue === null ||
      issue.projectId !== input.projectId ||
      issues.has(issue.id)
    )
      continue;
    add(key, issue);
  }
  for (const { key, issue } of await findOrphans(
    api,
    input.projectId,
    { keys: known, issueIds: issues },
    input.known,
    true,
  ))
    add(key, issue);
  const revision = Math.max(input.revision, other.revision) + 1;
  await api.updateDocument(input.documentId, {
    content: input.render(
      {
        revision,
        origin: input.origin,
        ...readyMarkOf(input.readyAt ?? other.ready_at),
        tasks: taskIdentifiers(tasks),
        milestones: { ...other.milestones, ...input.milestones },
      },
      tasks,
    ),
  });
  return { revision, tasks, keys, urls };
}

/** Reads the revision from Linear and refuses a request made against another one. */
async function expectRevision(
  deps: LedgerDeps,
  project: ProjectRow,
  expected: number,
): Promise<ProjectRow> {
  const current = await linearRevision(deps, project);
  if (expected !== current.planRevision)
    throw new BoardError(
      "conflict",
      `expected_revision ${expected} does not match the plan revision ${current.planRevision} recorded in Linear${current.planRevision > project.planRevision ? " (another machine published it)" : ""}: call plan_read first, then repeat the request against revision ${current.planRevision}.`,
      { expected, actual: current.planRevision, next_step: "plan_read" },
    );
  return current;
}

/** What the plan document's machine map records about the project's origin. */
/** Whether the plan has once passed readiness (ruling 12). */
function isReady(project: ProjectRow): boolean {
  return (project.readyAt ?? null) !== null;
}

/** The machine map's `ready_at` field, when the plan passed readiness. */
function readyMarkOf(readyAt: string | null | undefined): {
  readonly ready_at?: string;
} {
  return readyAt === null || readyAt === undefined ? {} : { ready_at: readyAt };
}

function originOf(project: ProjectRow): PlanOrigin {
  return project.adoption === "created" ? "created" : "adopted";
}

/** A request's content without its request id, session, confirm flag and accepted problems. */
function requestHash(request: Readonly<Record<string, unknown>>): string {
  const content = Object.fromEntries(
    Object.entries(request)
      .filter(
        ([field]) =>
          field !== "request_id" &&
          field !== "session_id" &&
          field !== "confirm" &&
          field !== "accept",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Managed mode before its first confirmed write: a dry run, unless the
 * request says `confirm: true` and its dry run is the one shown last.
 */
function dryRunFor(
  project: ProjectRow,
  confirm: boolean | undefined,
  hash: string,
): boolean {
  if (project.adoption !== "managed" || project.managedConfirmed) return false;
  return confirm !== true || project.dryRunHash !== hash;
}

/** Remembers the dry run just shown, so its confirm can apply it. */
function rememberDryRun(deps: LedgerDeps, project: ProjectRow, hash: string) {
  deps.store.putProject({
    ...requireProject(deps.store, project.key),
    dryRunHash: hash,
    updatedAt: deps.now().toISOString(),
  });
}

const UNMATCHED_CONFIRM =
  "confirm: true applies only the request whose dry run was shown last, and this request's dry run had not been shown. Nothing was written: show these changes to the user, then repeat this same request with confirm: true (and a new request_id).";

/** Runs a plan write, keeping the dry run's hash when it is one. */
async function runChecked(
  deps: LedgerDeps,
  request: Readonly<Record<string, unknown>> & {
    readonly confirm?: boolean | undefined;
  },
  input: Omit<RunInput, "dryRun">,
) {
  const hash = requestHash(request);
  const dryRun = dryRunFor(input.project, request.confirm, hash);
  const result = await runPlan({ ...input, dryRun });
  if (!dryRun) return result;
  rememberDryRun(deps, input.project, hash);
  return request.confirm === true
    ? { ...result, message: UNMATCHED_CONFIRM }
    : result;
}

export async function planPublish(deps: LedgerDeps, request: PlanPublish) {
  const context = planContext(deps, request);
  const { session } = context;
  const project = await expectRevision(
    deps,
    context.project,
    request.expected_revision,
  );
  const journal = currentRevision(deps.store, project);
  const previous = readPlan(journal);
  const next: PlanState = {
    record: {
      project: request.project,
      ...(request.policy === undefined ? {} : { policy: request.policy }),
      label_groups: request.label_groups ?? [],
      labels: request.labels ?? [],
      milestones: withCodes(request.milestones ?? []),
      documents: request.documents ?? [],
      links: request.links ?? [],
      milestone_ids: previous?.record.milestone_ids ?? {},
    },
    tasks: request.tasks,
  };
  return runChecked(deps, request, {
    deps,
    project,
    session,
    previous,
    journal,
    next,
    requestId: request.request_id,
    overwrite: request.overwrite ?? [],
    update: request.update,
    source: "ledger:plan_publish",
    accept: request.accept ?? [],
  });
}

/** The plan an edit starts from: the current revision, or the project as it stands. */
async function basePlan(
  deps: LedgerDeps,
  project: ProjectRow,
  journal: JournalRevision | undefined,
): Promise<PlanState> {
  const previous = readPlan(journal);
  if (previous !== undefined)
    return {
      record: structuredClone(previous.record),
      tasks: structuredClone(previous.tasks),
    };
  const linearProject = await deps.linear().project(requireLinked(project));
  return {
    record: {
      project: { name: linearProject?.name ?? project.key },
      label_groups: [],
      labels: [],
      milestones: [],
      documents: [],
      links: [],
      milestone_ids: {},
    },
    tasks: (journal?.tasks ?? []).map((task) =>
      definitionSchema.parse(task.definition),
    ),
  };
}

export async function planEdit(deps: LedgerDeps, request: PlanEdit) {
  const context = planContext(deps, request);
  const { session } = context;
  const project = await expectRevision(
    deps,
    context.project,
    request.expected_revision,
  );
  const journal = currentRevision(deps.store, project);
  const previous = readPlan(journal);
  const next = await basePlan(deps, project, journal);
  const issues = new Issues();
  for (const [index, operation] of request.operations.entries()) {
    switch (operation.op) {
      case "add_task":
        if (next.tasks.some((task) => task.key === operation.task.key))
          issues.add(
            ["operations", index, "task", "key"],
            `task ${operation.task.key} exists already`,
          );
        else next.tasks.push(operation.task);
        break;
      case "update_task": {
        const position = next.tasks.findIndex(
          (task) =>
            task.key === operation.task_id ||
            (/^[A-Za-z][A-Za-z0-9]*-\d+$/u.test(operation.task_id) &&
              task.key.toUpperCase() === operation.task_id.toUpperCase()),
        );
        const { op: _op, task_id: taskId, ...patch } = operation;
        void _op;
        if (position >= 0) {
          const current = next.tasks[position];
          if (current !== undefined)
            next.tasks[position] = taskDefinitionSchema.parse({
              ...current,
              ...withoutUndefined(patch),
            });
        } else {
          const issue = await deps.linear().issue(taskId);
          if (issue === null || issue.projectId !== project.linearProjectId) {
            issues.add(
              ["operations", index, "task_id"],
              `no task ${taskId} in the plan or the project`,
            );
            break;
          }
          next.tasks.push(
            taskDefinitionSchema.parse({
              ...definitionFromIssue(issue, issue.identifier),
              ...withoutUndefined(patch),
            }),
          );
        }
        break;
      }
      case "add_milestone": {
        const code =
          operation.milestone.code ?? `M${next.record.milestones.length + 1}`;
        if (next.record.milestones.some((milestone) => milestone.code === code))
          issues.add(
            ["operations", index, "milestone", "code"],
            `milestone ${code} exists already`,
          );
        else next.record.milestones.push({ ...operation.milestone, code });
        break;
      }
      case "update_milestone": {
        const position = next.record.milestones.findIndex(
          (milestone) => milestone.code === operation.code,
        );
        const current = next.record.milestones[position];
        if (current === undefined) {
          issues.add(
            ["operations", index, "code"],
            `no milestone ${operation.code}`,
          );
          break;
        }
        next.record.milestones[position] = {
          ...current,
          ...(operation.name === undefined ? {} : { name: operation.name }),
          ...(operation.description === undefined
            ? {}
            : { description: operation.description }),
          ...(operation.target_date === undefined
            ? {}
            : { target_date: operation.target_date }),
        };
        break;
      }
      case "add_document":
        if (
          next.record.documents.some(
            (document) => document.title === operation.document.title,
          )
        )
          issues.add(
            ["operations", index, "document", "title"],
            `document ${operation.document.title} exists already`,
          );
        else next.record.documents.push(operation.document);
        break;
      case "add_labels":
        next.record.labels.push(...(operation.labels ?? []));
        next.record.label_groups.push(...(operation.label_groups ?? []));
        break;
      case "add_link":
        next.record.links.push(operation.link);
        break;
      case "set_project":
        next.record.project = projectDefinitionSchema.parse({
          ...next.record.project,
          ...withoutUndefined(operation.project),
        });
        break;
      case "set_policy":
        next.record.policy = projectPolicySchema.parse({
          ...next.record.policy,
          ...withoutUndefined(operation.policy),
        });
        break;
    }
  }
  issues.throwIfAny();
  return runChecked(deps, request, {
    deps,
    project,
    session,
    previous,
    journal,
    next,
    requestId: request.request_id,
    overwrite: request.overwrite ?? [],
    update: request.update,
    source: "ledger:plan_edit",
    accept: request.accept ?? [],
  });
}

/** A task definition read back from an issue's description. */
function definitionFromIssue(issue: Issue, key: string): TaskDefinition {
  const { sections } = parseDescription(issue.description);
  const definition: TaskDefinition = {
    key,
    title: plainTitle(issue.title, key).slice(0, 200) || issue.identifier,
    ...(sections.goal === undefined
      ? {}
      : { goal: sections.goal.slice(0, 20_000) }),
    ...(sections.criteria === undefined
      ? {}
      : {
          criteria: sections.criteria
            .map((criterion) => criterion.text.slice(0, 500))
            .slice(0, 100),
        }),
    ...(sections.rules === undefined
      ? {}
      : { rules: sections.rules.slice(0, 100) }),
    ...(sections.files === undefined
      ? {}
      : { files: sections.files.slice(0, 200) }),
    ...(sections.approach === undefined ? {} : { approach: sections.approach }),
    ...(sections.out_of_scope === undefined
      ? {}
      : { out_of_scope: sections.out_of_scope }),
    ...(sections.report === undefined ? {} : { report: sections.report }),
    ...(sections.original_behaviour === undefined
      ? {}
      : { original_behaviour: sections.original_behaviour }),
    ...(sections.root_cause === undefined
      ? {}
      : { root_cause: sections.root_cause }),
    ...(sections.evidence === undefined ? {} : { evidence: sections.evidence }),
    ...(issue.priority === 0 ? {} : { priority: issue.priority }),
    ...(issue.estimate === null ? {} : { estimate: issue.estimate }),
    ...(issue.dueDate === null ? {} : { due_date: issue.dueDate }),
  };
  const parsed = definitionSchema.safeParse(definition);
  return parsed.success ? parsed.data : { key, title: definition.title };
}

/**
 * Task-duplicate over a managed adopt: the adopted task against every task
 * of the current plan revision, as a publish adding it would read it.
 */
async function adoptDuplicateEntries(
  deps: LedgerDeps,
  project: ProjectRow,
  sessionId: string,
  issueId: string,
  task: StandardTask,
): Promise<PendingEntry[]> {
  if (deps.verifier === undefined) return [];
  const existing = (currentRevision(deps.store, project)?.tasks ?? [])
    .filter((entry) => entry.issueId !== issueId && entry.key !== task.key)
    .flatMap((entry) => {
      const parsed = definitionSchema.safeParse(entry.definition);
      return parsed.success
        ? [standardOf(parsed.data, parsed.data.status ?? "pending")]
        : [];
    });
  const entries = await deps.verifier.afterPlanChange(
    project.key,
    sessionId,
    { revision: 0, tasks: existing, policy: undefined },
    {
      revision: project.planRevision + 1,
      tasks: [...existing, task],
      policy: undefined,
    },
    "ledger:issue_adopt",
  );
  return entries.filter(
    ({ entry }) => describeEntry(entry).check === taskDuplicateBattery.id,
  );
}

export async function issueAdopt(deps: LedgerDeps, request: IssueAdopt) {
  const stored = requireProject(deps.store, projectKeyOf(request.project_id));
  const session = requireSession(
    deps.store,
    stored,
    sessionIdOf(request.session_id),
  );
  requireAdopted(stored);
  requireLinked(stored);
  // Adopting writes a plan revision: start from the one Linear records.
  const project = await linearRevision(deps, stored);
  const issue = await resolveIssue(deps, project, request.issue);
  // The issue's own identifier as a key, in any case, is that identifier.
  const adoptKey =
    request.key.toUpperCase() === issue.identifier.toUpperCase()
      ? issue.identifier
      : request.key;
  const parsed = parseDescription(issue.description);
  const definition = definitionFromIssue(issue, adoptKey);
  const task = standardOf(
    definition,
    taskView(issue, adoptKey, new Map(), null).status,
  );
  const missing = missingSections(parsed.sections);
  const detail = (extra: readonly PendingEntry[] = []): VerificationItem[] => {
    if (deps.verifier === undefined) return [];
    const access = deps.store.verificationAccess();
    const pending = [
      ...planDetailEntries(
        project.key,
        session.id,
        [task],
        "ledger:issue_adopt",
        deps.verifier.judgment.config,
      ),
      ...extra,
    ];
    return deps.store.transaction(() => recordEntries(access, pending));
  };
  const view = {
    key: adoptKey,
    identifier: issue.identifier,
    url: issue.url,
    title: definition.title,
    sections: parsed.sections,
    unknown_headings: parsed.unknownHeadings,
  };
  if (project.adoption === "as_is") {
    const verification = detail();
    return {
      mode: project.adoption,
      written: false,
      task: view,
      missing_sections: missing,
      plan_revision: project.planRevision,
      ...(verification.length === 0 ? {} : { verification }),
    };
  }
  requireCoordinator(project, session);
  const journal = currentRevision(deps.store, project);
  const teamKey = await teamKeyOf(deps.linear(), project);
  // An identifier-shaped key names an issue: only the adopted issue's own.
  if (
    isTeamIdentifier(request.key, teamKey) &&
    request.key.toUpperCase() !== issue.identifier.toUpperCase()
  )
    throw new BoardError(
      "invalid",
      `Key ${request.key} looks like an issue identifier but ${issue.identifier} is being adopted; use ${issue.identifier} itself or a plan key such as AREA-KIND-1.`,
      [
        {
          field: ["key"],
          message: "identifier-shaped key of another issue",
          type: "plan",
        },
      ],
    );
  // An issue the plan keys already keeps its key.
  const keyed = journal?.tasks.find(
    (entry) => entry.issueId === issue.id && entry.key !== adoptKey,
  );
  if (keyed !== undefined)
    throw new BoardError(
      "conflict",
      `${issue.identifier} is already in the plan as ${keyed.key}; issue_adopt does not re-key a task.`,
      { task_id: keyed.key, identifier: issue.identifier },
    );
  const clash = journal?.tasks.find(
    (entry) => entry.key === adoptKey && entry.issueId !== issue.id,
  );
  if (clash !== undefined)
    throw new BoardError(
      "conflict",
      `Plan key ${adoptKey} already names ${clash.identifier}.`,
      { task_id: adoptKey, identifier: clash.identifier },
    );
  const base = await basePlan(deps, project, journal);
  if (
    request.milestone !== undefined &&
    !base.record.milestones.some(
      (milestone) => milestone.code === request.milestone,
    )
  )
    throw new BoardError(
      "invalid",
      `Milestone ${request.milestone} is not in the plan.`,
    );
  const api = deps.linear();
  const milestoneId =
    request.milestone === undefined
      ? undefined
      : base.record.milestone_ids[request.milestone];
  let current = issue;
  const patch: IssueFields = {
    ...(milestoneId !== undefined && issue.projectMilestoneId === null
      ? { projectMilestoneId: milestoneId }
      : {}),
    ...(project.adoption === "managed" &&
    MANAGED_PREFIXES_EXISTING_TITLES &&
    !issue.title.startsWith(`${adoptKey}: `)
      ? { title: `${adoptKey}: ${issue.title}` }
      : {}),
  };
  let planDocumentId = project.planDocumentId;
  const documents = await api.documents(requireLinked(project));
  const planDoc =
    documents.find((entry) => entry.id === planDocumentId) ??
    documents.find((entry) => entry.title === PLAN_DOCUMENT_TITLE);
  // A managed adopt is gated while the plan has not passed readiness
  // (ruling 12), with the checks a publish runs on a task: its missing
  // sections (as publish's completeness: `depends_on` is not required),
  // plan-detail, task-duplicate against the plan's other tasks, and
  // `judgment:unavailable` without a judgment source. They block until
  // fixed in Linear or accepted by id. Passing it readies this task only;
  // the plan stays gated until a plan write passes.
  const gated = project.adoption === "managed" && !isReady(project);
  const duplicates = gated
    ? await adoptDuplicateEntries(deps, project, session.id, issue.id, task)
    : [];
  const readiness = gated
    ? applyAccept(
        [
          ...completenessProblems({
            tasks: {
              [adoptKey]: missing.filter((field) => field !== "depends_on"),
            },
          }),
          ...entryProblems(duplicates),
          ...(deps.verifier === undefined && !deps.checksOff
            ? [JUDGMENT_UNAVAILABLE]
            : []),
          ...entryProblems(
            planDetailEntries(
              project.key,
              session.id,
              [task],
              "ledger:issue_adopt",
              deps.verifier?.judgment.config,
            ),
          ),
        ],
        request.accept ?? [],
      )
    : undefined;
  const readyFields =
    readiness === undefined
      ? {}
      : {
          ready: readiness.blocking.length === 0,
          problems: readiness.blocking,
          ...(readiness.accepted.length === 0
            ? {}
            : { accepted: readiness.accepted.map((problem) => problem.id) }),
        };
  // Managed mode: the first write is shown as a dry run, as plans are.
  const hash = requestHash(request);
  if (dryRunFor(project, request.confirm, hash)) {
    rememberDryRun(deps, project, hash);
    const changes: PlannedChange[] = [];
    if (Object.keys(patch).length > 0)
      changes.push({
        object: "issue",
        key: adoptKey,
        action: "update",
        fields: changeFields(new Map(Object.entries(patch)), { ...issue }),
      });
    changes.push({
      object: "document",
      key: PLAN_DOCUMENT_TITLE,
      action: planDoc === undefined ? "create" : "update",
    });
    return {
      dry_run: true,
      ...readyFields,
      mode: project.adoption,
      written: false,
      task: view,
      missing_sections: missing,
      plan_revision: project.planRevision,
      changes,
      message:
        request.confirm === true
          ? UNMATCHED_CONFIRM
          : "Managed mode: nothing was written. Show these changes to the user; repeat the same request with confirm: true (and a new request_id) to apply them.",
    };
  }
  if (readiness !== undefined && readiness.blocking.length > 0)
    return {
      ...readyFields,
      mode: project.adoption,
      written: false,
      task: view,
      missing_sections: missing,
      plan_revision: project.planRevision,
      message: NOT_READY_MESSAGE,
    };
  const verification = detail(duplicates);
  if (Object.keys(patch).length > 0)
    current = await api.updateIssue(issue.id, patch);
  const tasks = (journal?.tasks ?? []).filter(
    (entry) => entry.issueId !== issue.id,
  );
  const adopted: JournalTask = {
    key: adoptKey,
    issueId: current.id,
    identifier: current.identifier,
    title: current.title,
    definition: {
      ...definition,
      ...(request.milestone === undefined
        ? {}
        : { milestone: request.milestone }),
    },
  };
  const revision = project.planRevision + 1;
  const now = deps.now().toISOString();
  const allTasks = [...tasks, adopted];
  const render = (map: PlanMap, entries: readonly JournalTask[]) =>
    renderPlanDocument(
      map,
      entries.map((entry) => ({
        key: entry.key,
        identifier: entry.identifier,
        title: entry.title,
      })),
      base.record.milestones.map((milestone) => ({
        code: milestone.code,
        name: milestone.name,
      })),
    );
  const content = render(
    {
      revision,
      origin: originOf(project),
      ...readyMarkOf(project.readyAt),
      tasks: taskIdentifiers(allTasks),
      milestones: base.record.milestone_ids,
    },
    allTasks,
  );
  // The plan document is re-read right before and after the write, as a
  // publish does: another coordinator's map for this revision is merged
  // into the next one instead of being overwritten.
  let other: PlanMap | undefined;
  if (planDoc === undefined) {
    const created = await createToolDocument(api, {
      id: stableId(project.linearProjectId, "document", PLAN_DOCUMENT_TITLE),
      projectId: project.linearProjectId,
      title: PLAN_DOCUMENT_TITLE,
      icon: PLAN_DOCUMENT_ICON,
      content,
    });
    planDocumentId = created.id;
  } else {
    planDocumentId = planDoc.id;
    other = await foreignMap(
      api,
      project.linearProjectId,
      planDoc.id,
      revision,
      allTasks,
    );
    if (other === undefined) {
      await api.updateDocument(planDoc.id, { content });
      other = await foreignMap(
        api,
        project.linearProjectId,
        planDoc.id,
        revision,
        allTasks,
      );
    }
  }
  let finalRevision = revision;
  let finalTasks: readonly JournalTask[] = allTasks;
  let mergedWith: { revision: number; keys: string[] } | undefined;
  if (other !== undefined && planDocumentId !== null) {
    const merged = await mergePlanMaps(
      api,
      {
        projectId: project.linearProjectId,
        documentId: planDocumentId,
        revision,
        tasks: allTasks,
        origin: originOf(project),
        readyAt: project.readyAt ?? null,
        milestones: base.record.milestone_ids,
        render,
        known: journalKeys(deps.store, project),
      },
      other,
    );
    finalRevision = merged.revision;
    finalTasks = merged.tasks;
    mergedWith = { revision: other.revision, keys: merged.keys };
  }
  deps.store.transaction(() => {
    deps.store.putRevision({
      projectKey: project.key,
      revision: finalRevision,
      sessionId: session.id,
      createdAt: now,
      tasks: finalTasks,
      policy: journal?.policy ?? null,
      plan: { ...base.record },
    });
    deps.store.putProject({
      ...requireProject(deps.store, project.key),
      planRevision: finalRevision,
      planDocumentId,
      ...(project.adoption === "managed"
        ? { managedConfirmed: true, dryRunHash: null }
        : {}),
      updatedAt: now,
    });
    deps.store.cacheIssues(project.key, [current]);
  });
  return {
    mode: project.adoption,
    written: true,
    task: { ...view, identifier: current.identifier, url: current.url },
    missing_sections: missing,
    plan_revision: finalRevision,
    ...(readiness === undefined
      ? {}
      : {
          ready: true,
          ...(readiness.accepted.length === 0
            ? {}
            : { accepted: readiness.accepted.map((problem) => problem.id) }),
        }),
    ...(mergedWith === undefined ? {} : { merged_with: mergedWith }),
    ...(verification.length === 0 ? {} : { verification }),
  };
}

/** The task map of a revision, as plan_read returns it. */
function taskMapOf(journal: JournalRevision | undefined) {
  return Object.fromEntries(
    (journal?.tasks ?? []).map((task) => [
      task.key,
      { ...task.definition, identifier: task.identifier },
    ]),
  );
}

export function planRead(deps: LedgerDeps, request: PlanRead) {
  const project = requireProject(deps.store, projectKeyOf(request.project_id));
  const requested = request.revision ?? project.planRevision;
  for (const endpoint of [requested, request.compare_to])
    if (endpoint != null && endpoint > project.planRevision)
      throw new BoardError(
        "invalid",
        "The plan revision is newer than the current plan revision.",
        { requested: endpoint, current: project.planRevision },
      );
  const read = (revision: number) => {
    if (revision === 0) return undefined;
    const journal = deps.store.revision(project.key, revision);
    if (journal === undefined)
      throw new BoardError(
        "not_found",
        `Plan revision ${revision} is not in this machine's journal.`,
        { plan_revision: revision },
      );
    return journal;
  };
  const journal = read(requested);
  const result = {
    project_id: project.key,
    plan_revision: requested,
    ...(journal === undefined
      ? {}
      : {
          metadata: {
            actor_id: journal.sessionId,
            created_at: journal.createdAt,
          },
        }),
  };
  const after = taskMapOf(journal);
  if (request.compare_to == null)
    return {
      ...result,
      task_map: after,
      ...(journal?.policy == null ? {} : { policy: journal.policy }),
    };
  const before = taskMapOf(read(request.compare_to));
  const added: Record<string, unknown> = {};
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, value] of Object.entries(after).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const prior = before[key];
    if (prior === undefined) added[key] = value;
    else if (!isDeepStrictEqual(prior, value))
      changed[key] = { before: prior, after: value };
  }
  return {
    ...result,
    compare_to: request.compare_to,
    added,
    changed,
    removed: Object.keys(before)
      .filter((key) => !(key in after))
      .sort(),
  };
}

export function planAck(deps: LedgerDeps, request: PlanAck) {
  const { store } = deps;
  const project = requireProject(store, projectKeyOf(request.project_id));
  const session = requireSession(
    store,
    project,
    sessionIdOf(request.session_id),
  );
  if (request.plan_revision > project.planRevision)
    throw new BoardError(
      "invalid",
      "Cannot acknowledge a future plan revision.",
      {
        requested: request.plan_revision,
        current: project.planRevision,
      },
    );
  if (
    session.acknowledgedPlanRevision !== null &&
    request.plan_revision < session.acknowledgedPlanRevision
  )
    throw new BoardError(
      "conflict",
      "A plan acknowledgment cannot move backwards.",
    );
  const now = deps.now().toISOString();
  const acknowledgedAt =
    request.plan_revision === session.acknowledgedPlanRevision &&
    session.acknowledgedAt !== null
      ? session.acknowledgedAt
      : now;
  store.putSession({
    ...session,
    acknowledgedPlanRevision: request.plan_revision,
    acknowledgedAt,
    lastSeenAt: now,
  });
  return {
    plan_revision: project.planRevision,
    session_id: session.id,
    acknowledged_plan_revision: request.plan_revision,
    acknowledged_at: acknowledgedAt,
  };
}

/** Rebuilds the plan map from the `vibecheck plan` document, for a second machine. */
export async function recoverPlanMap(
  deps: LedgerDeps,
  project: ProjectRow,
  documents: readonly Document[],
  /** Also when Linear's map has this machine's revision (with another map). */
  sameRevision = false,
): Promise<ProjectRow> {
  const planDoc = documents.find(
    (entry) => entry.title === PLAN_DOCUMENT_TITLE,
  );
  if (planDoc === undefined) return project;
  const map = parsePlanDocument(planDoc.content);
  if (
    map === null ||
    map.revision < project.planRevision ||
    (map.revision === project.planRevision && !sameRevision)
  )
    return project;
  const api = deps.linear();
  const tasks: JournalTask[] = [];
  for (const [key, identifier] of Object.entries(map.tasks)) {
    const issue = await api.issue(identifier);
    if (issue === null) continue;
    tasks.push({
      key,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      definition: { ...definitionFromIssue(issue, key) },
    });
  }
  const policyDoc = documents.find(
    (entry) => entry.title === POLICY_DOCUMENT_TITLE,
  );
  const now = deps.now().toISOString();
  const linearProject = await api.project(project.linearProjectId);
  const record: PlanRecord = {
    project: { name: linearProject?.name ?? project.key },
    label_groups: [],
    labels: [],
    milestones: [],
    documents: [],
    links: [],
    milestone_ids: map.milestones,
  };
  const recovered: ProjectRow = {
    ...project,
    planRevision: map.revision,
    planDocumentId: planDoc.id,
    policyDocumentId: policyDoc?.id ?? project.policyDocumentId,
    readyAt: project.readyAt ?? map.ready_at ?? null,
    updatedAt: now,
  };
  deps.store.transaction(() => {
    deps.store.putRevision({
      projectKey: project.key,
      revision: map.revision,
      sessionId: null,
      createdAt: now,
      tasks,
      policy: null,
      plan: { ...record },
    });
    deps.store.putProject(recovered);
  });
  return recovered;
}

export type { Label };
