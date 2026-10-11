// project_join: a session joins a project.
//
// The first join of a project key registers it on this machine and its
// session becomes the coordinator. The team comes from `team`, then
// `linear.team` in config, then the only team the key sees. With
// `linear_project` the key maps to an existing Linear project, and the mode
// recorded in Linear decides how this machine treats it: a `vibecheck plan`
// document whose machine map says `"origin": "created"` means the tool
// created the project; a `vibecheck policy` document with the line
// `Adoption: managed` (or a machine map saying `"adopted"`) means managed,
// and this machine starts with its own dry run. The plan map is rebuilt from
// the plan document either way. Any other existing project needs the user's
// answer first: without `adopt` the join returns `adoption_required` with a
// summary of the project and the question to ask, and writes nothing. `adopt`
// is "as_is" (use the project as it is, recorded on this machine only, so
// another machine asks again) or "managed" (let vibecheck fill gaps after a
// dry run); repeating the join with the other answer switches modes.

import { BoardError } from "../errors.js";
import type { Document, Issue, LinearApi, Project } from "../linear/api.js";
import { agentLabelName } from "../linear/states.js";
import { parseDescription, type SectionField } from "../linear/sections.js";
import {
  PLAN_DOCUMENT_TITLE,
  POLICY_DOCUMENT_TITLE,
  parsePlanDocument,
  policySaysManaged,
} from "../linear/documents.js";
import type { AdoptionMode, ProjectRow, SessionRow } from "../local/types.js";
import { sessionIdSchema, type ProjectJoin } from "../schemas.js";
import { newSessionId, projectKeyOf, sessionIdOf } from "./access.js";
import { resolveTeam, type LedgerDeps } from "./context.js";
import { recoverPlanMap } from "./plan.js";
import { projectStatus } from "./status.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_ID = /-([0-9a-f]{12})$/iu;

/** The id Linear's `project(id:)` accepts, from a UUID, slug ID, slug or URL. */
export function projectRef(text: string): string {
  const trimmed = text.trim();
  const fromUrl = /\/project\/([^/?#]+)/u.exec(trimmed)?.[1];
  const candidate = fromUrl ?? trimmed;
  if (UUID.test(candidate)) return candidate;
  return SLUG_ID.exec(candidate)?.[1] ?? candidate;
}

export const ADOPTION_QUESTION =
  "May vibecheck update this Linear project to its own format? " +
  "Answer as_is to keep the project exactly as it is: vibecheck then only adds claim, report and verdict comments, its vc:* and agent:* labels on issues agents claim, and state moves on those issues. " +
  "Answer managed to let vibecheck fill empty fields, add missing description sections, dependency relations, milestones, labels and its policy and plan documents; it shows every change as a dry run first and never deletes, renames or overwrites what is set.";

async function summarize(api: LinearApi, project: Project) {
  const issues: Issue[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.issues({ projectId: project.id }, after);
    issues.push(...page.nodes);
    if (page.next === null) break;
    after = page.next;
  }
  const sections: Partial<Record<SectionField, number>> = {};
  let unknownHeadings = 0;
  let withCriteria = 0;
  for (const issue of issues) {
    const parsed = parseDescription(issue.description);
    for (const field of Object.keys(parsed.sections))
      if (isSectionField(field)) sections[field] = (sections[field] ?? 0) + 1;
    if ((parsed.sections.criteria ?? []).length > 0) withCriteria += 1;
    if (parsed.unknownHeadings.length > 0) unknownHeadings += 1;
  }
  const labelNames = new Map(
    (await api.labels(project.teamIds[0] ?? "")).map((label) => [
      label.id,
      label.name,
    ]),
  );
  const labelCounts = new Map<string, number>();
  for (const issue of issues)
    for (const id of issue.labelIds) {
      const name = labelNames.get(id);
      if (name !== undefined)
        labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1);
    }
  return {
    name: project.name,
    url: project.url,
    issue_count: issues.length,
    readable_sections: sections,
    issues_with_criteria: withCriteria,
    issues_with_other_headings: unknownHeadings,
    labels: [...labelCounts]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 30)
      .map(([name, count]) => ({ name, issues: count })),
    milestones: (await api.milestones(project.id)).map(
      (milestone) => milestone.name,
    ),
    documents: (await api.documents(project.id)).map(
      (document) => document.title,
    ),
  };
}

function isSectionField(value: string): value is SectionField {
  return [
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
  ].includes(value);
}

/**
 * The mode the project's own documents record: `created` when the plan
 * document's machine map says the tool created the project, `managed` when
 * the policy document says `Adoption: managed` or the map says `adopted`;
 * undefined when nothing is recorded (a plan document alone proves nothing).
 */
export function recordedAdoption(
  documents: readonly Document[],
): "created" | "managed" | undefined {
  const plan = documents.find((entry) => entry.title === PLAN_DOCUMENT_TITLE);
  const origin =
    plan === undefined ? undefined : parsePlanDocument(plan.content)?.origin;
  if (origin === "created") return "created";
  const policy = documents.find(
    (entry) => entry.title === POLICY_DOCUMENT_TITLE,
  );
  if (origin === "adopted") return "managed";
  if (policy !== undefined && policySaysManaged(policy.content))
    return "managed";
  return undefined;
}

async function adoptionRequired(api: LinearApi, project: Project) {
  return {
    adoption_required: true,
    project: {
      linear_project_id: project.id,
      name: project.name,
      url: project.url,
    },
    summary: await summarize(api, project),
    question: ADOPTION_QUESTION,
    options: ["as_is", "managed"],
    next_step:
      'Ask the user the question, then call project_join again with adopt "as_is" or "managed" (and a new request_id).',
  };
}

export async function projectJoin(deps: LedgerDeps, request: ProjectJoin) {
  const { store } = deps;
  const key = projectKeyOf(request.project_id);
  const now = deps.now().toISOString();
  let project = store.project(key);
  const wantedRef =
    request.linear_project === undefined
      ? undefined
      : projectRef(request.linear_project);

  if (
    project === undefined ||
    (project.linearProjectId === "" && wantedRef !== undefined)
  ) {
    const api = deps.linear();
    let linked: Project | null = null;
    if (wantedRef !== undefined) {
      linked = await api.project(wantedRef);
      if (linked === null)
        throw new BoardError(
          "not_found",
          `Linear has no project ${request.linear_project ?? wantedRef} that this key can see.`,
        );
      const other = store.projectByLinearId(linked.id);
      if (other !== undefined && other.key !== key)
        throw new BoardError(
          "conflict",
          `Linear project ${linked.name} is already joined as project ${other.key}.`,
          { project_id: other.key },
        );
    }
    const team =
      linked === null
        ? await resolveTeam(api, request.team ?? deps.config.team)
        : await teamOf(api, linked, request.team ?? deps.config.team);
    let adoption: AdoptionMode = "created";
    let documents: Awaited<ReturnType<LinearApi["documents"]>> = [];
    if (linked !== null) {
      documents = await api.documents(linked.id);
      const recorded = recordedAdoption(documents);
      adoption =
        recorded === "created"
          ? "created"
          : (request.adopt ?? recorded ?? "pending");
      if (adoption === "pending") return adoptionRequired(api, linked);
    }
    const repositories = [
      ...new Set([...(project?.repositories ?? []), request.repository]),
    ];
    project = {
      key,
      linearProjectId: linked?.id ?? "",
      teamId: team.id,
      repositories,
      policyDocumentId: project?.policyDocumentId ?? null,
      planDocumentId: project?.planDocumentId ?? null,
      planRevision: project?.planRevision ?? 0,
      coordinatorSessionId: project?.coordinatorSessionId ?? null,
      syncedThrough: null,
      adoption,
      managedConfirmed: false,
      policy: project?.policy ?? null,
      url: linked?.url ?? null,
      name: linked?.name ?? null,
      createdAt: project?.createdAt ?? now,
      updatedAt: now,
    };
    if (linked !== null)
      project = await recoverPlanMap(deps, project, documents);
  } else {
    if (
      wantedRef !== undefined &&
      project.linearProjectId !== "" &&
      wantedRef !== project.linearProjectId
    ) {
      const linked = await deps.linear().project(wantedRef);
      if (linked?.id !== project.linearProjectId)
        throw new BoardError(
          "conflict",
          `Project ${key} is already linked to a different Linear project.`,
          { linear_project_id: project.linearProjectId },
        );
    }
    if (project.adoption === "pending" && request.adopt === undefined) {
      const api = deps.linear();
      const linked = await api.project(project.linearProjectId);
      if (linked !== null) return adoptionRequired(api, linked);
    }
    const adoption: AdoptionMode =
      request.adopt === undefined || project.adoption === "created"
        ? project.adoption
        : request.adopt;
    project = {
      ...project,
      repositories: [...new Set([...project.repositories, request.repository])],
      adoption,
      managedConfirmed:
        adoption === project.adoption ? project.managedConfirmed : false,
      updatedAt: now,
    };
  }

  // The session.
  const parentId =
    request.parent_session_id == null
      ? null
      : sessionIdOf(request.parent_session_id);
  if (parentId !== null) {
    const parent = store.session(parentId);
    if (parent === undefined || parent.projectKey !== key)
      throw new BoardError(
        "not_found",
        `Parent session ${parentId} is not in project ${key}.`,
      );
  }
  const existing = store
    .sessions(key)
    .find(
      (session) =>
        session.vendor === request.vendor &&
        session.runtime === request.runtime &&
        session.externalSessionId === request.external_session_id,
    );
  if (existing !== undefined && existing.parentSessionId !== parentId)
    throw new BoardError("conflict", "A session's parent cannot change.");
  if (project.coordinatorSessionId === null && parentId !== null)
    throw new BoardError(
      "invalid",
      "The first session must be a root session.",
    );
  if (request.take_over_from != null) {
    if (project.coordinatorSessionId !== sessionIdOf(request.take_over_from))
      throw new BoardError(
        "conflict",
        "Coordinator takeover does not match the current coordinator.",
      );
    if (parentId !== null)
      throw new BoardError(
        "forbidden",
        "Only a root session can become coordinator.",
      );
  }
  const session: SessionRow = {
    id: existing?.id ?? newSessionId(),
    projectKey: key,
    vendor: request.vendor,
    runtime: request.runtime,
    externalSessionId: request.external_session_id,
    model: request.model,
    effort: request.effort ?? null,
    parentSessionId: parentId,
    agentLabel: agentLabelName(request.vendor),
    acknowledgedPlanRevision: existing?.acknowledgedPlanRevision ?? null,
    acknowledgedAt: existing?.acknowledgedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
  };
  const coordinator =
    project.coordinatorSessionId === null || request.take_over_from != null
      ? session.id
      : project.coordinatorSessionId;
  const final: ProjectRow = { ...project, coordinatorSessionId: coordinator };
  store.transaction(() => {
    store.putProject(final);
    store.putSession(session);
  });
  const status = await projectStatus(deps, {
    project_id: request.project_id,
    session_id: sessionIdSchema.parse(session.id),
  });
  return {
    session_id: session.id,
    coordinator: coordinator === session.id,
    coordinator_session_id: coordinator,
    agent_label: session.agentLabel,
    project: status.project,
    plan_revision: final.planRevision,
    status,
  };
}

async function teamOf(
  api: LinearApi,
  project: Project,
  wanted: string | null | undefined,
) {
  const teams = (await api.teams()).filter((team) =>
    project.teamIds.includes(team.id),
  );
  if (wanted !== undefined && wanted !== null && wanted !== "") {
    const team = teams.find(
      (entry) =>
        entry.key.toUpperCase() === wanted.toUpperCase() || entry.id === wanted,
    );
    if (team === undefined)
      throw new BoardError(
        "invalid",
        `Linear project ${project.name} does not belong to team ${wanted}; its teams are ${teams.map((entry) => entry.key).join(", ")}.`,
      );
    return team;
  }
  const first = teams[0];
  if (first === undefined)
    throw new BoardError(
      "not_found",
      `The key sees none of ${project.name}'s teams.`,
    );
  return first;
}
