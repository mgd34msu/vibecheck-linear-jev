// The LinearApi contract against real Linear. Runs only with
// VLJ_LIVE_LINEAR=1 and LINEAR_API_KEY set; everything it creates is named
// `vc-test-...` and deleted when the file finishes.

import assert from "node:assert/strict";
import test from "node:test";
import { GraphqlLinearApi } from "../src/linear/graphql.js";
import { linearContract } from "./linear-contract.js";

const key = process.env.LINEAR_API_KEY ?? "";
const enabled = process.env.VLJ_LIVE_LINEAR === "1" && key !== "";
const skip = enabled
  ? false
  : "set VLJ_LIVE_LINEAR=1 and LINEAR_API_KEY to run";
const teamKey = process.env.VLJ_LIVE_TEAM ?? "TA";
const prefix = `vc-test-${Date.now().toString(36)}`;
const COMPLEXITY_CAP = 10_000;

let shared: GraphqlLinearApi | null = null;
function api(): GraphqlLinearApi {
  shared ??= new GraphqlLinearApi({ apiKey: key });
  return shared;
}

async function teamId(): Promise<string> {
  const team = (await api().teams()).find(
    (candidate) => candidate.key === teamKey,
  );
  assert.ok(team !== undefined, `team ${teamKey} is visible to the key`);
  return team.id;
}

linearContract(
  "live",
  async () => {
    const client = api();
    return {
      api: client,
      teamId: await teamId(),
      prefix,
      deleteLabel: (id) => client.deleteLabel(id),
      deleteIssue: (id) => client.deleteIssue(id),
      multiSelectLabelGroups: process.env.VLJ_LIVE_MULTISELECT === "1",
      removeLabelOrFail: (issueId, labelId) =>
        client.sendRemoveLabel(issueId, labelId),
    };
  },
  { skip },
);

test(
  "live: every list query stays under the complexity cap",
  { skip },
  async () => {
    const client = api();
    const team = await teamId();
    const [project] = await client.projects(prefix);
    assert.ok(project !== undefined, "the contract project exists");
    const [issue] = (await client.issues({ projectId: project.id })).nodes;
    assert.ok(issue !== undefined, "the contract project has issues");
    const costs: Record<string, number | null> = {};
    const measure = async (name: string, run: () => Promise<unknown>) => {
      await run();
      costs[name] = client.lastComplexity();
    };
    await measure("teams", () => client.teams());
    await measure("workflowStates", () => client.workflowStates(team));
    await measure("projectStatuses", () => client.projectStatuses());
    await measure("labels", () => client.labels(team));
    await measure("project", () => client.project(project.id));
    await measure("projects", () => client.projects());
    await measure("milestones", () => client.milestones(project.id));
    await measure("documents", () => client.documents(project.id));
    await measure("externalLinks", () => client.externalLinks(project.id));
    await measure("issues", () => client.issues({ projectId: project.id }));
    await measure("issue", () => client.issue(issue.identifier));
    await measure("relations", () => client.relations(issue.id));
    await measure("comments", () => client.comments(issue.id));
    await measure("pullRequests", () => client.pullRequests(issue.id));
    await measure("projectUpdates", () => client.projectUpdates(project.id));
    process.stdout.write(`complexity per query: ${JSON.stringify(costs)}\n`);
    for (const [name, cost] of Object.entries(costs)) {
      assert.ok(cost === null || cost < COMPLEXITY_CAP, `${name} cost ${cost}`);
    }
    const rateLimit = client.rateLimit();
    assert.ok(rateLimit !== null);
    assert.ok(rateLimit.requestsLimit > 0 && rateLimit.complexityLimit > 0);
    assert.ok(rateLimit.resetAt > Date.now() - 60_000);
  },
);
