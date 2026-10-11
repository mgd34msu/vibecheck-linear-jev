// Request schemas for the eleven ledger tools (docs/protocol.md) and the shared value types the checks read: a task's
// standard (goal, criteria, rules, accepted exceptions) and the project
// policy. Every external value is validated here before any tool runs, so a
// request that fails validation writes nothing anywhere.

import { z } from "zod";
import { isValidIcon } from "./linear/icons.js";

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$(?![\s\S])/);
export const projectIdSchema = identifierSchema.brand<"ProjectId">();
export const sessionIdSchema = identifierSchema.brand<"SessionId">();
/** A plan key (`SAVE-FATAL-5`) or a Linear issue identifier (`TA-42`). */
export const taskIdSchema = identifierSchema.brand<"TaskId">();
export const workIdSchema = identifierSchema.brand<"WorkId">();
export const planRevisionSchema = z.number().int().nonnegative();

function limitedText(max: number) {
  return z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= max, {
      message: `String should have at most ${max} characters`,
    });
}

/**
 * Report text: trimmed, and whitespace-only text is no report at all (the
 * field reads as absent everywhere: comments, checks, history).
 */
export const reportTextSchema = z
  .string()
  .refine((value) => Array.from(value).length <= 20_000, {
    message: "String should have at most 20000 characters",
  })
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  });

/** A title: trimmed, on one line (line breaks and runs of spaces become one space). */
function titleText(max: number) {
  return z
    .string()
    .overwrite((value) => value.replace(/\s+/gu, " ").trim())
    .min(1)
    .refine((value) => Array.from(value).length <= max, {
      message: `String should have at most ${max} characters`,
    });
}

export const shortTextSchema = limitedText(500);
export const longTextSchema = limitedText(20_000);
/** Documents and the project overview may be long. */
export const documentTextSchema = limitedText(200_000);

export const commitSchema = z
  .string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$(?![\s\S])/)
  .overwrite((value) => value.toLowerCase());

export const taskStateSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "awaiting_integration",
  "complete",
  "cancelled",
]);
export type ProjectId = z.infer<typeof projectIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type WorkId = z.infer<typeof workIdSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;

const pathsSchema = z
  .array(shortTextSchema)
  .max(500)
  .superRefine((paths, context) => {
    if (
      paths.some(
        (path) =>
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some((part) => part === "" || part === "." || part === ".."),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "paths must be normalized repository-relative paths",
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "paths must be unique" });
    }
  });

export const locationSchema = z.strictObject({
  repository: shortTextSchema.nullable().optional(),
  checkout: shortTextSchema.nullable().optional(),
  branch: shortTextSchema.nullable().optional(),
  target_branch: shortTextSchema.nullable().optional(),
  base_commit: commitSchema.nullable().optional(),
  paths: pathsSchema.optional(),
});
export type Location = z.infer<typeof locationSchema>;

export const acceptedExceptionSchema = z.strictObject({
  description: shortTextSchema,
  paths: pathsSchema.optional(),
  data_only: z.boolean().optional(),
});
export const taskDetailsSchema = z.strictObject({
  goal: longTextSchema.optional(),
  criteria: z.array(shortTextSchema).max(100).optional(),
  rules: z.array(shortTextSchema).max(100).optional(),
  exceptions: z.array(acceptedExceptionSchema).max(100).optional(),
  parent: taskIdSchema.optional(),
});
export const projectPolicySchema = z.strictObject({
  goal: longTextSchema.optional(),
  rules: z.array(shortTextSchema).max(100).optional(),
  authorizations: z.array(shortTextSchema).max(100).optional(),
  stop_reasons: z.array(shortTextSchema).max(100).optional(),
});
export type AcceptedException = z.infer<typeof acceptedExceptionSchema>;
export type TaskDetails = z.infer<typeof taskDetailsSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

// ---------------------------------------------------------------------------
// Linear field values, checked before any write

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "expected a hex color such as #5e6ad2");
export const iconSchema = z.string().refine(isValidIcon, {
  message:
    "not an icon Linear accepts: use a known icon name (src/linear/icons.ts) or an emoji shortcode such as :rocket:",
});
export const dateSchema = z.iso.date();
export const dateResolutionSchema = z.enum([
  "month",
  "quarter",
  "halfYear",
  "year",
]);
export const prioritySchema = z.number().int().min(0).max(4);
export const healthSchema = z.enum(["onTrack", "atRisk", "offTrack"]);
const labelNameSchema = limitedText(80);

/** A plan task key: letters, digits, `.`, `_`, `-`; e.g. `SAVE-FATAL-5`. */
export const taskKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$(?![\s\S])/u,
    "expected letters, digits, '.', '_' or '-'",
  );
/** A milestone code: `M3`, `U`, `R1`. */
export const milestoneCodeSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$(?![\s\S])/u,
    "expected letters, digits, '.', '_' or '-'",
  );

export const labelDefinitionSchema = z.strictObject({
  name: labelNameSchema,
  color: colorSchema.optional(),
  description: shortTextSchema.optional(),
});
export const labelGroupSchema = z.strictObject({
  name: labelNameSchema,
  color: colorSchema.optional(),
  description: shortTextSchema.optional(),
  labels: z.array(labelDefinitionSchema).min(1).max(100),
});
export type LabelDefinition = z.infer<typeof labelDefinitionSchema>;
export type LabelGroupDefinition = z.infer<typeof labelGroupSchema>;

const projectFieldsShape = {
  name: limitedText(80),
  /** One line; becomes the Linear project description (at most 255 characters). */
  summary: z
    .string()
    .min(1)
    // Linear measures the description in UTF-16 code units, as JavaScript does.
    .refine((value) => value.length <= 255, {
      message:
        "summary must be at most 255 characters as Linear counts them (UTF-16 code units; an emoji counts as 2)",
    }),
  /** The full markdown overview; becomes the Linear project content. */
  overview: documentTextSchema,
  icon: iconSchema,
  color: colorSchema,
  priority: prioritySchema,
  status: z.enum(["backlog", "planned", "started"]),
  start_date: dateSchema,
  start_resolution: dateResolutionSchema,
  target_date: dateSchema,
  target_resolution: dateResolutionSchema,
  labels: z.array(labelDefinitionSchema).max(50),
};
export const projectDefinitionSchema = z.strictObject({
  name: projectFieldsShape.name,
  summary: projectFieldsShape.summary.optional(),
  overview: projectFieldsShape.overview.optional(),
  icon: projectFieldsShape.icon.optional(),
  color: projectFieldsShape.color.optional(),
  priority: projectFieldsShape.priority.optional(),
  status: projectFieldsShape.status.optional(),
  start_date: projectFieldsShape.start_date.optional(),
  start_resolution: projectFieldsShape.start_resolution.optional(),
  target_date: projectFieldsShape.target_date.optional(),
  target_resolution: projectFieldsShape.target_resolution.optional(),
  labels: projectFieldsShape.labels.optional(),
});
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;
export const projectPatchSchema = projectDefinitionSchema.partial();
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const milestoneDefinitionSchema = z.strictObject({
  code: milestoneCodeSchema.optional(),
  /** One line (rendered into the plan document's headings). */
  name: titleText(80),
  description: longTextSchema.optional(),
  target_date: dateSchema.optional(),
});
export type MilestoneDefinition = z.infer<typeof milestoneDefinitionSchema>;

export const documentDefinitionSchema = z.strictObject({
  title: limitedText(120),
  icon: iconSchema.optional(),
  color: colorSchema.optional(),
  content: documentTextSchema,
});
export type DocumentDefinition = z.infer<typeof documentDefinitionSchema>;

export const linkDefinitionSchema = z.strictObject({
  label: limitedText(120),
  url: z.url({ protocol: /^https?$/u }),
});
export type LinkDefinition = z.infer<typeof linkDefinitionSchema>;

const taskFieldsShape = {
  title: titleText(200),
  goal: longTextSchema,
  criteria: z.array(shortTextSchema).max(100),
  rules: z.array(shortTextSchema).max(100),
  exceptions: z.array(acceptedExceptionSchema).max(100),
  files: z.array(shortTextSchema).max(200),
  approach: longTextSchema,
  depends_on: z.array(taskIdSchema).max(1000),
  out_of_scope: z.array(shortTextSchema).max(100),
  report: longTextSchema,
  original_behaviour: longTextSchema,
  root_cause: longTextSchema,
  evidence: longTextSchema,
  parent: taskIdSchema,
  milestone: milestoneCodeSchema,
  labels: z.array(labelNameSchema).max(20),
  priority: prioritySchema,
  estimate: z.number().int().min(0).max(1000),
  due_date: dateSchema,
  status: z.enum(["pending", "cancelled"]),
  supersedes: z.array(taskIdSchema).max(1000),
};

export const taskDefinitionSchema = z.strictObject({
  key: taskKeySchema,
  title: taskFieldsShape.title,
  goal: taskFieldsShape.goal.optional(),
  criteria: taskFieldsShape.criteria.optional(),
  rules: taskFieldsShape.rules.optional(),
  exceptions: taskFieldsShape.exceptions.optional(),
  files: taskFieldsShape.files.optional(),
  approach: taskFieldsShape.approach.optional(),
  depends_on: taskFieldsShape.depends_on.optional(),
  out_of_scope: taskFieldsShape.out_of_scope.optional(),
  report: taskFieldsShape.report.optional(),
  original_behaviour: taskFieldsShape.original_behaviour.optional(),
  root_cause: taskFieldsShape.root_cause.optional(),
  evidence: taskFieldsShape.evidence.optional(),
  parent: taskFieldsShape.parent.optional(),
  milestone: taskFieldsShape.milestone.optional(),
  labels: taskFieldsShape.labels.optional(),
  priority: taskFieldsShape.priority.optional(),
  estimate: taskFieldsShape.estimate.optional(),
  due_date: taskFieldsShape.due_date.optional(),
  status: taskFieldsShape.status.optional(),
  supersedes: taskFieldsShape.supersedes.optional(),
});
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;

export const projectUpdateSchema = z.strictObject({
  health: healthSchema.optional(),
  body: longTextSchema,
});

// ---------------------------------------------------------------------------
// Requests

const mutationShape = {
  project_id: projectIdSchema,
  request_id: identifierSchema,
};
const sessionMutationShape = { ...mutationShape, session_id: sessionIdSchema };
/** Field paths a managed-mode plan write may overwrite, e.g. `project.color`, `tasks.TA-7.priority`. */
const overwriteSchema = z.array(shortTextSchema).max(1000);
/** Problem ids of the first publish's readiness check the request accepts. */
const acceptSchema = z.array(shortTextSchema).max(5000);

export const projectJoinSchema = z.strictObject({
  ...mutationShape,
  repository: shortTextSchema,
  vendor: shortTextSchema,
  runtime: shortTextSchema,
  external_session_id: shortTextSchema,
  model: shortTextSchema,
  effort: shortTextSchema.nullable().optional(),
  parent_session_id: sessionIdSchema.nullable().optional(),
  take_over_from: sessionIdSchema.nullable().optional(),
  /** An existing Linear project: UUID, slug ID, or URL. */
  linear_project: shortTextSchema.optional(),
  /** Team key, e.g. `TA`, when the key sees several teams and config names none. */
  team: shortTextSchema.optional(),
  /** The user's answer to the adoption question for an existing project. */
  adopt: z.enum(["as_is", "managed"]).optional(),
});

export const planPublishSchema = z.strictObject({
  ...sessionMutationShape,
  expected_revision: planRevisionSchema,
  project: projectDefinitionSchema,
  policy: projectPolicySchema.optional(),
  label_groups: z.array(labelGroupSchema).max(20).optional(),
  labels: z.array(labelDefinitionSchema).max(200).optional(),
  milestones: z.array(milestoneDefinitionSchema).max(100).optional(),
  documents: z.array(documentDefinitionSchema).max(50).optional(),
  links: z.array(linkDefinitionSchema).max(50).optional(),
  tasks: z.array(taskDefinitionSchema).max(2000),
  update: projectUpdateSchema.optional(),
  confirm: z.boolean().optional(),
  overwrite: overwriteSchema.optional(),
  accept: acceptSchema.optional(),
});

const taskPatchSchema = z
  .strictObject({
    op: z.literal("update_task"),
    task_id: taskIdSchema,
    title: taskFieldsShape.title.optional(),
    goal: taskFieldsShape.goal.optional(),
    criteria: taskFieldsShape.criteria.optional(),
    rules: taskFieldsShape.rules.optional(),
    exceptions: taskFieldsShape.exceptions.optional(),
    files: taskFieldsShape.files.optional(),
    approach: taskFieldsShape.approach.optional(),
    depends_on: taskFieldsShape.depends_on.optional(),
    out_of_scope: taskFieldsShape.out_of_scope.optional(),
    report: taskFieldsShape.report.optional(),
    original_behaviour: taskFieldsShape.original_behaviour.optional(),
    root_cause: taskFieldsShape.root_cause.optional(),
    evidence: taskFieldsShape.evidence.optional(),
    parent: taskFieldsShape.parent.optional(),
    milestone: taskFieldsShape.milestone.optional(),
    labels: taskFieldsShape.labels.optional(),
    priority: taskFieldsShape.priority.optional(),
    estimate: taskFieldsShape.estimate.optional(),
    due_date: taskFieldsShape.due_date.optional(),
    status: taskFieldsShape.status.optional(),
    supersedes: taskFieldsShape.supersedes.optional(),
  })
  .refine(
    (operation) =>
      Object.keys(operation).some((key) => key !== "op" && key !== "task_id"),
    { message: "update_task requires at least one changed field" },
  );
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const planOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add_task"), task: taskDefinitionSchema }),
  taskPatchSchema,
  z.strictObject({
    op: z.literal("add_milestone"),
    milestone: milestoneDefinitionSchema,
  }),
  z.strictObject({
    op: z.literal("update_milestone"),
    code: milestoneCodeSchema,
    name: titleText(80).optional(),
    description: longTextSchema.optional(),
    target_date: dateSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("add_document"),
    document: documentDefinitionSchema,
  }),
  z.strictObject({
    op: z.literal("add_labels"),
    labels: z.array(labelDefinitionSchema).max(200).optional(),
    label_groups: z.array(labelGroupSchema).max(20).optional(),
  }),
  z.strictObject({
    op: z.literal("add_link"),
    link: linkDefinitionSchema,
  }),
  z.strictObject({ op: z.literal("set_project"), project: projectPatchSchema }),
  z.strictObject({ op: z.literal("set_policy"), policy: projectPolicySchema }),
]);
export type PlanOperation = z.infer<typeof planOperationSchema>;

export const planEditSchema = z.strictObject({
  ...sessionMutationShape,
  expected_revision: planRevisionSchema,
  operations: z.array(planOperationSchema).min(1).max(2000),
  update: projectUpdateSchema.optional(),
  confirm: z.boolean().optional(),
  overwrite: overwriteSchema.optional(),
  accept: acceptSchema.optional(),
});

export const planAckSchema = z.strictObject({
  ...sessionMutationShape,
  plan_revision: planRevisionSchema,
});

export const planReadSchema = z.strictObject({
  project_id: projectIdSchema,
  revision: planRevisionSchema.nullable().optional(),
  compare_to: planRevisionSchema.nullable().optional(),
});

export const issueAdoptSchema = z.strictObject({
  ...sessionMutationShape,
  /** Issue identifier (`TA-42`) or its Linear URL. */
  issue: shortTextSchema,
  key: taskKeySchema,
  milestone: milestoneCodeSchema.optional(),
  /** Managed mode: apply after the dry run of this same request was shown. */
  confirm: z.boolean().optional(),
  /** Readiness problem ids of the first managed write this request accepts. */
  accept: acceptSchema.optional(),
});

export const workClaimSchema = z.strictObject({
  ...sessionMutationShape,
  task_id: taskIdSchema,
  location: locationSchema.optional(),
  replace_work_id: workIdSchema.nullable().optional(),
  /**
   * Closes an open claim comment whose work this machine does not know and
   * that shows no tool activity for 24 hours, then claims.
   */
  force_release: z.boolean().optional(),
});

const workStatusSchema = z.enum([
  "in_progress",
  "blocked",
  "awaiting_integration",
  "complete",
]);
/** A change whose report was whitespace only carries no report key at all. */
export const workProgressSchema = z
  .strictObject({
    work_id: workIdSchema,
    action: z.literal("progress").optional(),
    status: workStatusSchema.optional(),
    location: locationSchema.nullable().optional(),
    blocker: shortTextSchema.nullable().optional(),
    commit: commitSchema.nullable().optional(),
    integration_commit: commitSchema.nullable().optional(),
    report: reportTextSchema.optional(),
  })
  .refine(
    (change) =>
      !(
        change.status === "complete" &&
        change.blocker !== undefined &&
        change.blocker !== null
      ),
    {
      message:
        "a change to status complete cannot carry a blocker: report the blocker with status blocked, or drop it",
      path: ["blocker"],
    },
  )
  .transform(({ report, ...rest }) => ({
    ...rest,
    ...(report === undefined ? {} : { report }),
  }));
export const workReleaseSchema = z
  .strictObject({
    work_id: workIdSchema,
    action: z.literal("release"),
    report: reportTextSchema.optional(),
  })
  .transform(({ report, ...rest }) => ({
    ...rest,
    ...(report === undefined ? {} : { report }),
  }));
export const workHandoffSchema = z
  .strictObject({
    work_id: workIdSchema,
    action: z.literal("handoff"),
    handoff_to: sessionIdSchema,
    report: reportTextSchema.optional(),
  })
  .transform(({ report, ...rest }) => ({
    ...rest,
    ...(report === undefined ? {} : { report }),
  }));
export const workChangeSchema = z.union([
  workProgressSchema,
  workReleaseSchema,
  workHandoffSchema,
]);
export const workUpdateSchema = z.strictObject({
  ...sessionMutationShape,
  updates: z.array(workChangeSchema).min(1).max(100),
});

export const projectStatusSchema = z
  .strictObject({
    project_id: projectIdSchema,
    /** The calling session: `next` then leads with its own work. */
    session_id: sessionIdSchema.nullable().optional(),
    full: z.boolean().optional(),
    include_map: z.boolean().optional(),
    known_plan_revision: planRevisionSchema.nullable().optional(),
    task_ids: z.array(taskIdSchema).min(1).max(1000).nullable().optional(),
  })
  .refine((request) => !(request.full === true && request.task_ids != null), {
    message: "full cannot be combined with task_ids",
  });

export const workHistorySchema = z
  .strictObject({
    project_id: projectIdSchema,
    task_id: taskIdSchema.nullable().optional(),
    session_id: sessionIdSchema.nullable().optional(),
    path: shortTextSchema.nullable().optional(),
    branch: shortTextSchema.nullable().optional(),
    commit: commitSchema.nullable().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .refine(
    (request) =>
      Boolean(
        request.task_id ||
        request.session_id ||
        request.path ||
        request.branch ||
        request.commit,
      ),
    { message: "at least one history selector is required" },
  );

export const projectUpdateRequestSchema = z.strictObject({
  ...sessionMutationShape,
  health: healthSchema.optional(),
  body: longTextSchema.optional(),
});

export const requestSchemas = {
  project_join: projectJoinSchema,
  plan_publish: planPublishSchema,
  plan_edit: planEditSchema,
  plan_read: planReadSchema,
  plan_ack: planAckSchema,
  issue_adopt: issueAdoptSchema,
  work_claim: workClaimSchema,
  work_update: workUpdateSchema,
  project_status: projectStatusSchema,
  work_history: workHistorySchema,
  project_update: projectUpdateRequestSchema,
};
export type ToolName = keyof typeof requestSchemas;
export const TOOL_NAMES: readonly ToolName[] = [
  "project_join",
  "plan_publish",
  "plan_edit",
  "plan_read",
  "plan_ack",
  "issue_adopt",
  "work_claim",
  "work_update",
  "project_status",
  "work_history",
  "project_update",
];

export type ProjectJoin = z.infer<typeof projectJoinSchema>;
export type PlanPublish = z.infer<typeof planPublishSchema>;
export type PlanEdit = z.infer<typeof planEditSchema>;
export type PlanAck = z.infer<typeof planAckSchema>;
export type PlanRead = z.infer<typeof planReadSchema>;
export type IssueAdopt = z.infer<typeof issueAdoptSchema>;
export type WorkClaim = z.infer<typeof workClaimSchema>;
export type WorkProgress = z.infer<typeof workProgressSchema>;
export type WorkRelease = z.infer<typeof workReleaseSchema>;
export type WorkHandoff = z.infer<typeof workHandoffSchema>;
export type WorkChange = z.infer<typeof workChangeSchema>;
export type WorkUpdate = z.infer<typeof workUpdateSchema>;
export type ProjectStatusRequest = z.infer<typeof projectStatusSchema>;
export type WorkHistory = z.infer<typeof workHistorySchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
