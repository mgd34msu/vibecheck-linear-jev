import assert from "node:assert/strict";
import test, { after } from "node:test";
import { z } from "zod";
import {
  errorFromGraphql,
  isLinearError,
  LinearError,
  retryAfterFromHeaders,
} from "../src/linear/errors.js";
import { GraphqlLinearApi } from "../src/linear/graphql.js";

const KEY = "lin_api_test_key_0000";
const NOW = 1_791_677_000_000;

const recordedBody = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()),
});

interface Recorded {
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

type Reply = (request: Recorded) => Response | Promise<Response>;

const requests: Recorded[] = [];
const replies: Reply[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = recordedBody.parse(await request.json());
    const recorded: Recorded = {
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      query: body.query,
      variables: body.variables,
    };
    requests.push(recorded);
    const reply = replies.shift();
    if (reply === undefined) {
      return Response.json(
        { errors: [{ message: "no reply queued" }] },
        { status: 500 },
      );
    }
    return reply(recorded);
  },
});
after(() => server.stop(true));

function reset(...queued: Reply[]): void {
  requests.length = 0;
  replies.length = 0;
  replies.push(...queued);
}

function client(
  overrides: Partial<ConstructorParameters<typeof GraphqlLinearApi>[0]> = {},
) {
  return new GraphqlLinearApi({
    apiKey: KEY,
    endpoint: server.url.href,
    retryDelayMs: 0,
    now: () => NOW,
    ...overrides,
  });
}

function data(value: unknown, headers: Record<string, string> = {}): Reply {
  return () => Response.json({ data: value }, { headers });
}

function graphqlError(
  status: number,
  entry: Record<string, unknown>,
  headers: Record<string, string> = {},
): Reply {
  return () =>
    Response.json({ errors: [entry], data: null }, { status, headers });
}

const RATE_HEADERS = {
  "x-ratelimit-requests-limit": "2500",
  "x-ratelimit-requests-remaining": "2400",
  "x-ratelimit-requests-reset": String(NOW + 60_000),
  "x-ratelimit-complexity-limit": "3000000",
  "x-ratelimit-complexity-remaining": "2999000",
  "x-ratelimit-complexity-reset": String(NOW + 90_000),
  "x-complexity": "42",
};

const VIEWER = {
  id: "u1",
  name: "Mike",
  email: "mike@example.com",
  admin: true,
  organization: {
    id: "o1",
    name: "Example Workspace",
    urlKey: "example-workspace",
  },
};

function commentNode(id: string, createdAt: string) {
  return {
    id,
    body: `body ${id}`,
    createdAt,
    updatedAt: createdAt,
    user: { id: "u1" },
    issue: { id: "i1" },
    reactions: [{ emoji: "+1", user: { id: "u2" } }],
  };
}

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "i1",
    identifier: "TA-1",
    url: "https://linear.app/example-workspace/issue/TA-1/x",
    title: "x",
    description: null,
    priority: 0,
    estimate: null,
    labelIds: [],
    project: { id: "p1" },
    projectMilestone: null,
    parent: null,
    assignee: null,
    dueDate: null,
    branchName: "mike/ta-1-x",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    state: { id: "s1", name: "Backlog", type: "backlog" },
    ...overrides,
  };
}

test("graphql posts JSON with the bare personal key and maps the viewer", async () => {
  reset(data({ viewer: VIEWER }, RATE_HEADERS));
  const api = client();
  assert.equal(api.rateLimit(), null);
  assert.deepEqual(await api.viewer(), VIEWER);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request?.method, "POST");
  assert.equal(request?.authorization, KEY);
  assert.match(request?.contentType ?? "", /application\/json/);
  assert.match(
    request?.query ?? "",
    /viewer \{ id name email admin organization/,
  );
  assert.deepEqual(api.rateLimit(), {
    requestsLimit: 2500,
    requestsRemaining: 2400,
    complexityLimit: 3_000_000,
    complexityRemaining: 2_999_000,
    resetAt: NOW + 90_000,
  });
  assert.equal(api.lastComplexity(), 42);
});

test("graphql refuses an empty key before any request", () => {
  assert.throws(
    () => new GraphqlLinearApi({ apiKey: "  " }),
    (error) => isLinearError(error, "auth"),
  );
});

test("graphql maps HTTP 401 to auth and does not retry", async () => {
  reset(
    graphqlError(401, {
      message: "Authentication required, not authenticated",
      extensions: {
        code: "AUTHENTICATION_ERROR",
        statusCode: 401,
        userPresentableMessage:
          "You need to authenticate to access this operation.",
      },
    }),
  );
  await assert.rejects(client().viewer(), (error: unknown) => {
    assert.ok(isLinearError(error, "auth"));
    assert.equal(error.status, 401);
    assert.equal(
      error.message,
      "You need to authenticate to access this operation.",
    );
    return true;
  });
  assert.equal(requests.length, 1);
});

test("graphql maps validation errors (HTTP 200) to invalid with Linear's message", async () => {
  reset(
    graphqlError(200, {
      message: "Argument Validation Error",
      path: ["projectUpdate"],
      extensions: {
        code: "INVALID_INPUT",
        userPresentableMessage: "color must be a hexadecimal color.",
      },
    }),
  );
  await assert.rejects(
    client().updateProject("p1", { color: "red" }),
    (error: unknown) => {
      assert.ok(isLinearError(error, "invalid"));
      assert.equal(error.message, "color must be a hexadecimal color.");
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.variables, {
    id: "p1",
    input: { color: "red" },
  });
});

test("graphql maps 'Entity not found' to null for lookups and not_found otherwise", async () => {
  const notFound = graphqlError(200, {
    message: "Entity not found: Issue",
    extensions: {
      code: "INPUT_ERROR",
      statusCode: 400,
      userPresentableMessage: "Could not find referenced Issue.",
    },
  });
  reset(notFound, notFound);
  const api = client();
  assert.equal(await api.issue("TA-999999"), null);
  await assert.rejects(api.updateIssue("missing", { title: "x" }), (error) =>
    isLinearError(error, "not_found"),
  );
});

test("graphql throws rate_limited with retryAfterMs and does not retry", async () => {
  reset(
    graphqlError(
      400,
      { message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } },
      {
        ...RATE_HEADERS,
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": String(NOW + 12_000),
      },
    ),
  );
  const api = client();
  await assert.rejects(api.teams(), (error: unknown) => {
    assert.ok(isLinearError(error, "rate_limited"));
    assert.equal(error.retryAfterMs, 12_000);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(api.rateLimit()?.requestsRemaining, 0);
});

test("graphql maps a bare HTTP 429 to rate_limited", async () => {
  reset(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "3" },
      }),
  );
  await assert.rejects(client().viewer(), (error: unknown) => {
    assert.ok(isLinearError(error, "rate_limited"));
    assert.equal(error.retryAfterMs, 3000);
    return true;
  });
});

test("graphql retries a server error once, then succeeds", async () => {
  reset(
    () => new Response("upstream down", { status: 502 }),
    data({ viewer: VIEWER }),
  );
  assert.equal((await client().viewer()).id, "u1");
  assert.equal(requests.length, 2);
});

test("graphql gives up after one retry and throws server", async () => {
  const failing: Reply = () => new Response("boom", { status: 500 });
  reset(failing, failing, failing);
  await assert.rejects(client().viewer(), (error: unknown) => {
    assert.ok(isLinearError(error, "server"));
    assert.equal(error.status, 500);
    return true;
  });
  assert.equal(requests.length, 2);
});

test("graphql maps fetch failures and timeouts to network, retrying once", async () => {
  let calls = 0;
  const api = client({
    fetch: async () => {
      calls += 1;
      throw new TypeError("connection refused");
    },
  });
  await assert.rejects(api.viewer(), (error: unknown) => {
    assert.ok(isLinearError(error, "network"));
    assert.match(error.message, /connection refused/);
    return true;
  });
  assert.equal(calls, 2);

  reset(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(Response.json({ data: { viewer: VIEWER } })),
          300,
        ),
      ),
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(Response.json({ data: { viewer: VIEWER } })),
          300,
        ),
      ),
  );
  await assert.rejects(client({ timeoutMs: 30 }).viewer(), (error: unknown) => {
    assert.ok(isLinearError(error, "network"));
    assert.match(error.message, /did not respond within 30 ms/);
    return true;
  });
});

test("graphql reads a retried create back when the first attempt landed", async () => {
  const id = "c0ffee00-0000-4000-8000-000000000001";
  reset(
    () => new Response("gateway timeout", { status: 504 }),
    graphqlError(200, {
      message: "conflict on insert of Comment",
      extensions: {
        code: "INPUT_ERROR",
        statusCode: 400,
        userPresentableMessage: `Entity Comment with id ${id} already exists.`,
      },
    }),
    data({ comment: commentNode(id, "2026-10-10T00:00:00.000Z") }),
  );
  const comment = await client().createComment({
    id,
    issueId: "i1",
    body: "hi",
  });
  assert.equal(comment.id, id);
  assert.equal(requests.length, 3);
  assert.match(requests[2]?.query ?? "", /comment\(id: \$id\)/);
});

test("graphql reports a direct duplicate create as invalid", async () => {
  reset(
    graphqlError(200, {
      message: "conflict on insert of Project",
      extensions: {
        code: "INPUT_ERROR",
        statusCode: 400,
        userPresentableMessage: "Entity Project with id p1 already exists.",
      },
    }),
  );
  await assert.rejects(
    client().createProject({ id: "p1", name: "x", teamIds: ["t1"] }),
    (error: unknown) =>
      isLinearError(error, "invalid") && /already exists/.test(error.message),
  );
  assert.equal(requests.length, 1);
});

test("graphql loops over every page of comments and sorts them oldest first", async () => {
  reset(
    data({
      issue: {
        comments: {
          nodes: [commentNode("b", "2026-10-10T00:00:02.000Z")],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    }),
    data({
      issue: {
        comments: {
          nodes: [commentNode("a", "2026-10-10T00:00:01.000Z")],
          pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
        },
      },
    }),
  );
  const comments = await client().comments("i1");
  assert.deepEqual(
    comments.map((comment) => comment.id),
    ["a", "b"],
  );
  assert.deepEqual(comments[0]?.reactions, [{ emoji: "+1", userId: "u2" }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.variables, {
    id: "i1",
    first: 50,
    after: null,
  });
  assert.deepEqual(requests[1]?.variables, {
    id: "i1",
    first: 50,
    after: "cursor-1",
  });
});

test("graphql issues() returns one page, ascending by updatedAt, with the filter", async () => {
  reset(
    data({
      issues: {
        nodes: [issueNode()],
        pageInfo: { hasNextPage: true, endCursor: "next-1" },
      },
    }),
  );
  const page = await client().issues(
    { projectId: "p1", updatedAfter: "2026-10-01T00:00:00.000Z" },
    "prev",
  );
  assert.equal(page.next, "next-1");
  assert.equal(page.nodes[0]?.description, "");
  assert.match(
    requests[0]?.query ?? "",
    /sort: \[\{ updatedAt: \{ order: Ascending \} \}\]/,
  );
  assert.deepEqual(requests[0]?.variables, {
    filter: {
      project: { id: { eq: "p1" } },
      updatedAt: { gt: "2026-10-01T00:00:00.000Z" },
    },
    includeArchived: false,
    first: 50,
    after: "prev",
  });
});

test("graphql folds Linear's duplicate state type into canceled", async () => {
  reset(
    data({
      workflowStates: {
        nodes: [
          { id: "d", name: "Duplicate", type: "duplicate", position: 5 },
          { id: "b", name: "Backlog", type: "backlog", position: 0 },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  );
  assert.deepEqual(await client().workflowStates("t1"), [
    { id: "b", name: "Backlog", type: "backlog", position: 0 },
    { id: "d", name: "Duplicate", type: "canceled", position: 5 },
  ]);
});

test("graphql labels ask for team labels and workspace labels", async () => {
  reset(
    data({
      issueLabels: {
        nodes: [
          {
            id: "l1",
            name: "vc:claimed",
            color: "#5e6ad2",
            description: null,
            isGroup: false,
            parent: { id: "g1" },
            team: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  );
  const labels = await client().labels("t1");
  assert.deepEqual(labels, [
    {
      id: "l1",
      name: "vc:claimed",
      color: "#5e6ad2",
      description: null,
      isGroup: false,
      parentId: "g1",
      teamId: null,
    },
  ]);
  assert.match(requests[0]?.query ?? "", /team: \{ null: true \}/);
});

test("graphql relations merge both directions without duplicates", async () => {
  const relation = (id: string, from: string, to: string) => ({
    id,
    type: "blocks",
    issue: { id: from },
    relatedIssue: { id: to },
  });
  const empty = { hasNextPage: false, endCursor: null };
  reset(
    (request) =>
      Response.json({
        data: {
          issue: request.query.includes("inverseRelations")
            ? {
                inverseRelations: {
                  nodes: [relation("r2", "i0", "i1")],
                  pageInfo: empty,
                },
              }
            : {
                relations: {
                  nodes: [relation("r1", "i1", "i2")],
                  pageInfo: empty,
                },
              },
        },
      }),
    (request) =>
      Response.json({
        data: {
          issue: request.query.includes("inverseRelations")
            ? {
                inverseRelations: {
                  nodes: [relation("r2", "i0", "i1")],
                  pageInfo: empty,
                },
              }
            : {
                relations: {
                  nodes: [relation("r1", "i1", "i2")],
                  pageInfo: empty,
                },
              },
        },
      }),
  );
  const relations = await client().relations("i1");
  assert.deepEqual(relations.map((candidate) => candidate.id).sort(), [
    "r1",
    "r2",
  ]);
});

test("graphql maps GitHub and GitLab attachments to pull requests, skipping others", async () => {
  reset(
    data({
      issue: {
        attachments: {
          nodes: [
            {
              id: "a1",
              title: "P03.01: storage checks",
              url: "https://github.com/example/app/pull/48",
              sourceType: "github",
              metadata: {
                id: "4815041368",
                branch: "mgd34msu/ta-2996-storage",
                number: 48,
                draft: false,
                createdAt: "2026-10-10T22:58:55.000Z",
                closedAt: null,
                mergedAt: null,
                hasConflicts: true,
                repoLogin: "mgd34msu",
                repoName: "app",
              },
            },
            {
              id: "a2",
              title: "Design doc",
              url: "https://example.com/doc",
              sourceType: null,
              metadata: {},
            },
            {
              id: "a3",
              title: "MR !7",
              url: "https://gitlab.com/x/y/-/merge_requests/7",
              sourceType: "gitlab",
              metadata: { number: "seven" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  );
  assert.deepEqual(await client().pullRequests("i1"), [
    {
      url: "https://github.com/example/app/pull/48",
      title: "P03.01: storage checks",
      source: "github",
      number: 48,
      branch: "mgd34msu/ta-2996-storage",
      draft: false,
      createdAt: "2026-10-10T22:58:55.000Z",
      closedAt: null,
      mergedAt: null,
      hasConflicts: true,
    },
    {
      url: "https://gitlab.com/x/y/-/merge_requests/7",
      title: "MR !7",
      source: "gitlab",
      number: null,
      branch: null,
      draft: null,
      createdAt: null,
      closedAt: null,
      mergedAt: null,
      hasConflicts: null,
    },
  ]);
});

test("graphql treats a trashed project as gone and unexpected shapes as server errors", async () => {
  reset(
    data({
      project: {
        id: "p1",
        slugId: "abc",
        url: "https://linear.app/x/project/abc",
        name: "gone",
        icon: null,
        color: "#000000",
        description: "",
        content: null,
        status: { id: "s" },
        priority: 0,
        lead: null,
        members: { nodes: [] },
        labelIds: [],
        startDate: null,
        targetDate: null,
        teams: { nodes: [{ id: "t1" }] },
        updatedAt: "2026-10-10T00:00:00.000Z",
        trashed: true,
      },
    }),
    data({ viewer: { id: 7 } }),
  );
  const api = client();
  assert.equal(await api.project("abc"), null);
  await assert.rejects(api.viewer(), (error) => isLinearError(error, "server"));
});

test("errors: retryAfterFromHeaders prefers the exhausted window", () => {
  const headers = new Headers({
    "x-ratelimit-requests-remaining": "10",
    "x-ratelimit-requests-reset": String(NOW + 50_000),
    "x-ratelimit-complexity-remaining": "0",
    "x-ratelimit-complexity-reset": String(NOW + 5_000),
  });
  assert.equal(retryAfterFromHeaders(headers, NOW), 5_000);
  assert.equal(retryAfterFromHeaders(new Headers(), NOW), undefined);
  assert.equal(
    retryAfterFromHeaders(new Headers({ "retry-after": "2" }), NOW),
    2_000,
  );
});

test("errors: the most limiting GraphQL error decides the kind", () => {
  const error = errorFromGraphql(
    [
      { message: "bad field", extensions: { code: "INVALID_INPUT" } },
      { message: "who are you", extensions: { code: "AUTHENTICATION_ERROR" } },
    ],
    200,
    new Headers(),
    NOW,
  );
  assert.ok(error instanceof LinearError);
  assert.equal(error.kind, "auth");
  assert.equal(error.retryable, false);
  const server = errorFromGraphql(
    [{ message: "oops", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    500,
    new Headers(),
    NOW,
  );
  assert.equal(server.kind, "server");
  assert.equal(server.retryable, true);
});
