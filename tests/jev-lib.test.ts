import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { BATTERIES, batteryById } from "../src/jev/registry.js";
import { otherWorkText, standardClaims } from "../src/jev/standard.js";
import {
  briefScopeBattery,
  claimGroundedBattery,
  deferralBattery,
  doneAdmitsUnfinishedBattery,
  stopReasonBattery,
} from "../src/jev/batteries.js";
import {
  configTemplate,
  configCommand,
  ensureConfig,
} from "../src/jev/config-file.js";
import {
  ConfigError,
  loadConfig,
  parseConfig,
  parseConfigText,
  stripJsonComments,
} from "../src/jev/config.js";
import { isJudgment, openJudgment, runCheck } from "../src/jev/judgment.js";
import { createSystemOneServer, toWire } from "../src/jev/laya.js";
import {
  AuthError,
  FailoverProvider,
  JevProvider,
  NoSourceError,
  ProviderUnavailableError,
  ScriptedProvider,
  exceededLimit,
  noul,
  runBattery,
  type EvaluateRequest,
  type Evaluation,
  type SystemOneProvider,
} from "../src/jev/lib/index.js";
import {
  configFile,
  dataDirectory,
  defaultDatabase,
  layaDirectory,
} from "../src/paths.js";

function temporary(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

class FailingProvider implements SystemOneProvider {
  readonly defaultModel = "none";
  calls = 0;
  constructor(
    readonly id: string,
    readonly error: Error,
  ) {}
  async evaluate(_request: EvaluateRequest): Promise<Evaluation> {
    this.calls += 1;
    throw this.error;
  }
}

const question = { passed: noul("Does `state` say the tests passed?") };

test("every battery lints clean and has fixtures with expectations", () => {
  assert.equal(BATTERIES.length, 19);
  for (const battery of BATTERIES) {
    assert.ok(battery.fixtureCount >= 3, `${battery.id} has fixtures`);
    assert.ok(battery.id.startsWith("vibecheck."));
    for (const value of Object.values(battery.thresholds))
      assert.ok(value >= 0 && value <= 1);
  }
  assert.equal(
    new Set(BATTERIES.map((battery) => battery.id)).size,
    BATTERIES.length,
  );
});

test("done-admits-unfinished blocks at blockAt and reads the task, exceptions and report", async () => {
  const input = {
    task: "Task fmt: write formatJson.",
    report: "Nothing is implemented. Marking done anyway.",
  };
  const admitted = await runBattery(doneAdmitsUnfinishedBattery, input, {
    provider: new ScriptedProvider(() => 0.6),
  });
  assert.deepEqual(admitted.decision, { admits: 0.6, block: true });
  const finished = await runBattery(doneAdmitsUnfinishedBattery, input, {
    provider: new ScriptedProvider(() => 0.59),
  });
  assert.equal(finished.decision.block, false);
  assert.deepEqual(doneAdmitsUnfinishedBattery.state(input), {
    task: input.task,
    acceptedExceptions: "none recorded",
    report: input.report,
  });
  const raised = await runBattery(doneAdmitsUnfinishedBattery, input, {
    provider: new ScriptedProvider(() => 0.7),
    thresholdsFor: (id) =>
      id === "vibecheck.done-admits-unfinished" ? { blockAt: 0.8 } : undefined,
  });
  assert.equal(raised.decision.block, false);
  assert.ok(configTemplate().includes('"vibecheck.done-admits-unfinished": {'));
});

test("sources are tried in order and an unreachable one fails over to the next", async () => {
  const down = new ScriptedProvider(() => 0.9, "down", 1);
  const up = new ScriptedProvider(() => 0.9, "up");
  const chain = new FailoverProvider([{ provider: down }, { provider: up }]);
  const evaluation = await chain.evaluate({
    state: "tests passed",
    questions: question,
  });
  assert.equal(evaluation.providerId, "up");
  assert.deepEqual(
    evaluation.skipped?.map((skip) => skip.sourceId),
    ["down"],
  );
  const first = await chain.evaluate({ state: "again", questions: question });
  assert.equal(
    first.providerId,
    "down",
    "a recovered first source answers again",
  );
});

test("an auth failure stops the chain instead of moving on", async () => {
  const locked = new FailingProvider(
    "locked",
    new AuthError("authentication failed (401)"),
  );
  const next = new ScriptedProvider(() => 0.9, "next");
  const chain = new FailoverProvider([
    { provider: locked },
    { provider: next },
  ]);
  await assert.rejects(
    chain.evaluate({ state: "s", questions: question }),
    AuthError,
  );
  assert.equal(next.requests.length, 0);
  const allDown = new FailoverProvider([
    {
      provider: new FailingProvider(
        "a",
        new ProviderUnavailableError("timeout"),
      ),
    },
    {
      provider: new FailingProvider(
        "b",
        new ProviderUnavailableError("refused"),
      ),
    },
  ]);
  await assert.rejects(
    allDown.evaluate({ state: "s", questions: question }),
    (error: unknown) =>
      error instanceof NoSourceError &&
      /a: timeout; b: refused/u.test(error.message),
  );
});

test("a reading over a source's input limit skips that source and records why", async () => {
  const small = new ScriptedProvider(() => 0.9, "small");
  const large = new ScriptedProvider(() => 0.9, "large");
  const chain = new FailoverProvider([
    { provider: small, limits: { maxStateTokens: 10 } },
    { provider: large },
  ]);
  const evaluation = await chain.evaluate({
    state: "x".repeat(200),
    questions: question,
  });
  assert.equal(evaluation.providerId, "large");
  assert.equal(small.requests.length, 0);
  assert.match(evaluation.skipped?.[0]?.reason ?? "", /exceeds 10/u);
  assert.equal(
    exceededLimit(
      { state: "short", questions: question },
      { maxStateTokens: 10 },
    ),
    undefined,
  );
});

test("per-check routing sends a check's readings to its sources in the given order", async () => {
  const first = new ScriptedProvider(() => 0.9, "first");
  const second = new ScriptedProvider(() => 0.9, "second");
  const chain = new FailoverProvider(
    [{ provider: first }, { provider: second }],
    new Map([["vibecheck.deferral", ["second"]]]),
  );
  const routed = await chain.evaluate({
    state: "s",
    questions: question,
    batteryId: "vibecheck.deferral",
  });
  assert.equal(routed.providerId, "second");
  const unrouted = await chain.evaluate({
    state: "s",
    questions: question,
    batteryId: "vibecheck.gives-up",
  });
  assert.equal(unrouted.providerId, "first");
});

test("per-check and per-source thresholds change the decision only where they apply", async () => {
  const provider = new ScriptedProvider(() => 0.55, "src");
  const input = { standard: "Fix the tests.", message: "Later." };
  const base = await runBattery(deferralBattery, input, { provider });
  assert.equal(base.decision.block, false, "0.55 is under the default 0.6");
  const config = parseConfig({
    sources: [
      { kind: "openjev", id: "src", baseURL: "http://127.0.0.1:1", model: "m" },
    ],
    checks: {
      "vibecheck.deferral": { sourceThresholds: { src: { blockAt: 0.5 } } },
    },
  });
  const judgment = openJudgment(config, { environment: {} });
  assert.ok(isJudgment(judgment));
  const stricter = await runBattery(deferralBattery, input, {
    provider,
    thresholdsFor: judgment.thresholdsFor,
  });
  assert.equal(stricter.decision.block, true);
  assert.deepEqual(stricter.thresholds, { blockAt: 0.5 });
  const other = await runBattery(deferralBattery, input, {
    provider: new ScriptedProvider(() => 0.55, "other"),
    thresholdsFor: judgment.thresholdsFor,
  });
  assert.equal(other.decision.block, false);
  const general = parseConfig({
    checks: { "vibecheck.deferral": { thresholds: { blockAt: 0.5 } } },
  });
  const opened = openJudgment(general, {
    environment: { TYPESAFE_API_KEY: "k" },
  });
  assert.ok(isJudgment(opened));
  assert.deepEqual(opened.thresholdsFor("vibecheck.deferral", "typesafe"), {
    blockAt: 0.5,
  });
});

test("a turned-off check does not read", async () => {
  const provider = new ScriptedProvider(() => 0.9);
  const config = parseConfig({
    checks: { "vibecheck.deferral": { enabled: false } },
  });
  const opened = openJudgment(config, {
    environment: { TYPESAFE_API_KEY: "k" },
  });
  assert.ok(isJudgment(opened));
  const result = await runCheck({ ...opened, provider }, deferralBattery, {
    standard: "a",
    message: "b",
  });
  assert.equal(result.kind, "disabled");
  assert.equal(provider.requests.length, 0);
});

test("config validation errors name the file, the key and what was expected", () => {
  const cases: [unknown, RegExp][] = [
    [
      { sources: [{ kind: "openjev", id: "x", model: "m" }] },
      /sources\.0\.baseURL/u,
    ],
    [
      {
        sources: [
          { kind: "typesafe", id: "a" },
          { kind: "typesafe", id: "a" },
        ],
      },
      /sources\.1\.id: expected a unique source id/u,
    ],
    [
      { checks: { "vibecheck.deferral": { thresholds: { blockAt: 1.5 } } } },
      /checks\.vibecheck\.deferral\.thresholds\.blockAt: expected a probability from 0 to 1/u,
    ],
    [
      { checks: { "vibecheck.deferral": { sources: ["missing"] } } },
      /checks\.vibecheck\.deferral\.sources\.0: expected a configured source id, got missing/u,
    ],
    [{ hooks: { stopSeconds: "soon" } }, /hooks\.stopSeconds/u],
    [{ unknown: true }, /unknown/u],
    [
      {
        sources: [
          { kind: "typesafe", id: "t", auth: { apiKey: "a", apiKeyEnv: "B" } },
        ],
      },
      /auth\.apiKey: expected apiKey or apiKeyEnv\/apiKeyFile, not both/u,
    ],
  ];
  for (const [value, pattern] of cases)
    assert.throws(
      () => parseConfig(value, "/etc/example.jsonc"),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.startsWith("/etc/example.jsonc: ") &&
        pattern.test(error.message),
    );
});

test("comments and trailing commas are stripped outside strings only", () => {
  const text = `{
    // a comment
    "url": "http://example.com/a//b", /* block */
    "quote": "say \\"// not a comment\\" here",
    "list": [1, 2,],
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(text)), {
    url: "http://example.com/a//b",
    quote: 'say "// not a comment" here',
    list: [1, 2],
  });
  assert.equal(stripJsonComments('"a,}"'), '"a,}"');
});

test("the pre-populated config parses, lists every check and has no personal values", () => {
  const template = configTemplate();
  const config = parseConfigText(template, "template");
  assert.deepEqual(
    Object.keys(config.checks ?? {}).sort(),
    [
      ...BATTERIES.map((battery) => battery.id),
      "vibecheck.commit-paths",
      "vibecheck.exception-check",
      "vibecheck.parent-rollup",
      "vibecheck.plan-detail",
    ].sort(),
  );
  for (const battery of BATTERIES)
    assert.deepEqual(
      config.checks?.[battery.id]?.thresholds,
      battery.thresholds,
    );
  assert.deepEqual(config.sources, [
    { kind: "typesafe", id: "typesafe", model: "jev-latest" },
  ]);
  assert.equal(config.data?.database, null);
  assert.doesNotMatch(template, /\/home\/|mgd34msu/u);
});

test("the config file is written on first run, never overwritten, and rewritten with a backup on init --force", async (t) => {
  const home = temporary(t, "vibecheck-linear-jev-config-");
  const environment = { XDG_CONFIG_HOME: home };
  const path = ensureConfig(environment);
  assert.equal(path, join(home, "vibecheck-linear-jev", "config.jsonc"));
  assert.equal(configFile(environment), path);
  writeFileSync(path, '{ "ledger": { "verify": false } }');
  ensureConfig(environment);
  assert.equal(readFileSync(path, "utf8"), '{ "ledger": { "verify": false } }');
  assert.equal(loadConfig(environment).ledger?.verify, false);
  const lines: string[] = [];
  const io = {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
    env: environment,
  };
  assert.equal(await configCommand(["init"], io), 1);
  assert.equal(await configCommand(["init", "--force"], io), 0);
  assert.equal(readFileSync(path, "utf8"), configTemplate());
  const backups = readdirSync(join(home, "vibecheck-linear-jev")).filter(
    (name) => name.endsWith(".bak"),
  );
  assert.equal(backups.length, 1);
  assert.equal(await configCommand(["path"], io), 0);
  assert.ok(lines.includes(path));
  assert.equal(
    configFile({ VIBECHECK_LINEAR_JEV_CONFIG: "/tmp/elsewhere.jsonc" }),
    "/tmp/elsewhere.jsonc",
  );
});

test("data paths follow XDG, the config and VIBECHECK_LINEAR_JEV_DB, and never the plugin folder", () => {
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: "/srv/data" }),
    "/srv/data/vibecheck-linear-jev",
  );
  assert.equal(
    defaultDatabase({ XDG_DATA_HOME: "/srv/data" }),
    "/srv/data/vibecheck-linear-jev/state.sqlite3",
  );
  assert.equal(
    defaultDatabase(
      { VIBECHECK_LINEAR_JEV_DB: "/srv/old.sqlite3" },
      { database: "/x.db" },
    ),
    "/srv/old.sqlite3",
  );
  assert.equal(
    defaultDatabase({}, { database: "/srv/configured.sqlite3" }),
    "/srv/configured.sqlite3",
  );
  assert.equal(
    defaultDatabase({}, { folder: "/srv/folder" }),
    "/srv/folder/state.sqlite3",
  );
  assert.equal(
    layaDirectory({ XDG_DATA_HOME: "/srv/data" }),
    "/srv/data/vibecheck-linear-jev/laya",
  );
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: "relative/path" }).endsWith(
      ".local/share/vibecheck-linear-jev",
    ),
    true,
  );
});

test("the hosted source needs a key; the others use their configured auth", () => {
  const none = openJudgment({}, { environment: {} });
  assert.equal(isJudgment(none), false);
  assert.match(JSON.stringify(none), /TYPESAFE_API_KEY/u);
  assert.equal(
    isJudgment(openJudgment({}, { environment: { TYPESAFE_API_KEY: "key" } })),
    true,
  );
  const missingEnv = openJudgment(
    parseConfig({
      sources: [
        {
          kind: "openjev",
          id: "o",
          baseURL: "http://127.0.0.1:1",
          model: "m",
          auth: { apiKeyEnv: "OPEN_KEY" },
        },
      ],
    }),
    { environment: {} },
  );
  assert.match(JSON.stringify(missingEnv), /OPEN_KEY is not set/u);
});

const scriptedModel = {
  name: "laya-test",
  async systemOne(
    _state: unknown,
    questions: Readonly<Record<string, unknown>>,
  ) {
    const answers: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(questions)) {
      const type = z.object({ type: z.string() }).parse(value).type;
      if (type === "noul")
        answers[id] = {
          type: "noul",
          noul: 0.8,
          rl_agent: { act_probability: 0.8 },
        };
      if (type === "choice")
        answers[id] = {
          type: "choice",
          choice: "excuse",
          confidence: 0.7,
          probabilities: {
            "allowed-by-rule": 0.1,
            excuse: 0.8,
            "blocked-external": 0.1,
          },
          rl_agent: { act_probability: 0.8 },
        };
      if (type === "score")
        answers[id] = {
          type: "score",
          score: 1.2,
          confidence: 0.6,
          probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
          legend: { "0": "a", "1": "b", "2": "c" },
          rl_agent: { act_probability: 0.6 },
        };
    }
    return {
      model: "laya-test",
      answers,
      usage: { input_tokens: 42, output_tokens: 0 },
    };
  },
  async close() {},
};

test("the Laya server answers the System One wire API the SDK speaks", async (t) => {
  const url = await listen(t, createSystemOneServer(scriptedModel));
  const provider = new JevProvider({
    id: "laya",
    baseURL: url,
    model: "laya-test",
  });
  const evaluation = await provider.evaluate({
    state: "The build passed.",
    questions: { passed: noul("Does `state` say it passed?") },
  });
  assert.deepEqual(evaluation.answers["passed"], { type: "noul", noul: 0.8 });
  assert.equal(evaluation.usage.inputTokens, 42);
  assert.equal(evaluation.providerId, "laya");
  const models = await provider.listModels();
  assert.equal(models[0]?.name, "laya-test");
  const reason = await runBattery(
    stopReasonBattery,
    { passage: "I left it because it looked risky." },
    { provider },
  );
  assert.equal(reason.decision.kind, "excuse");
  const wire = z
    .object({
      answers: z.record(z.string(), z.object({ type: z.string() }).loose()),
    })
    .parse(
      toWire(
        await scriptedModel.systemOne(null, { s: { type: "score" } }),
        "laya-test",
      ),
    );
  assert.equal(JSON.stringify(wire).includes("rl_agent"), false);
  const bad = await fetch(`${url}/v1/systemone`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(bad.status, 422);
});

test("a Jev-Style adapter response maps through the wire shape: P(true), per-option probabilities and the expected level", async (t) => {
  // What adapters/jev-style/server.py returns for decide_many results.
  const adapterResponse = {
    model: "jev-style",
    answers: {
      yes: { type: "noul", noul: 0.73 },
      pick: {
        type: "choice",
        choice: "b",
        confidence: 0.61,
        probabilities: { a: 0.2, b: 0.61, c: 0.19 },
      },
      level: {
        type: "score",
        score: 1.6,
        confidence: 0.5,
        probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
        legend: { "0": "low", "1": "mid", "2": "high" },
      },
    },
    usage: { input_tokens: 311, output_tokens: 0 },
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = z
        .object({
          state: z.unknown(),
          questions: z.record(z.string(), z.unknown()),
          model: z.string(),
        })
        .safeParse(JSON.parse(body));
      response.writeHead(parsed.success ? 200 : 422, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify(
          parsed.success ? adapterResponse : { error: "bad request" },
        ),
      );
    });
  });
  const url = await listen(t, server);
  const provider = new JevProvider({
    id: "jev-style",
    baseURL: url,
    model: "jev-style",
  });
  const evaluation = await provider.evaluate({
    state: "state",
    questions: {
      yes: noul("Is it yes?"),
      pick: {
        type: "choice",
        instructions: "Which one?",
        criteria: { a: "first", b: "second", c: "third" },
      },
      level: {
        type: "score",
        instructions: "How high?",
        criteria: ["low", "mid", "high"],
      },
    },
  });
  assert.deepEqual(evaluation.answers["yes"], { type: "noul", noul: 0.73 });
  assert.deepEqual(evaluation.answers["pick"], {
    type: "choice",
    choice: "b",
    confidence: 0.61,
    probabilities: { a: 0.2, b: 0.61, c: 0.19 },
  });
  assert.deepEqual(evaluation.answers["level"], {
    type: "score",
    score: 1.6,
    confidence: 0.5,
    probabilities: [0.1, 0.2, 0.7],
    legend: ["low", "mid", "high"],
  });
  assert.equal(evaluation.usage.inputTokens, 311);
});

test("claim-grounded exempts plans and proposals from the evidence rule", async () => {
  const provider = new ScriptedProvider((_battery, questionId) =>
    questionId === "ungrounded"
      ? 0.9
      : questionId === "notAssertion"
        ? 0.7
        : 0.1,
  );
  const run = await runBattery(
    claimGroundedBattery,
    { reply: "The queue would build files in the background.", evidence: "" },
    { provider },
  );
  assert.equal(run.decision.block, false);
  const fact = await runBattery(
    claimGroundedBattery,
    { reply: "The export times out.", evidence: "" },
    {
      provider: new ScriptedProvider((_battery, questionId) =>
        questionId === "ungrounded" ? 0.9 : 0.1,
      ),
    },
  );
  assert.equal(fact.decision.block, true);
  assert.ok(batteryById("vibecheck.claim-grounded") !== undefined);
  assert.equal(
    existsSync(join(process.cwd(), "adapters", "jev-style", "server.py")),
    true,
  );
});

test("claim-grounded v2: recommendations, questions, conditionals and statements marked unverified are exempt at planAt", async () => {
  const reading = (exempt: number) =>
    runBattery(
      claimGroundedBattery,
      { reply: "Should I merge it now?", evidence: "" },
      {
        provider: new ScriptedProvider((_battery, questionId) =>
          questionId === "ungrounded"
            ? 0.9
            : questionId === "notAssertion"
              ? exempt
              : 0.1,
        ),
      },
    );
  assert.equal(claimGroundedBattery.version, 2);
  assert.equal(claimGroundedBattery.thresholds.planAt, 0.5);
  assert.equal((await reading(0.55)).decision.block, false);
  assert.equal((await reading(0.45)).decision.block, true);
  const state = claimGroundedBattery.state({ reply: "r", evidence: "e" });
  assert.deepEqual(state, { reply: "r", evidence: "e" });
  assert.match(
    JSON.stringify(claimGroundedBattery.questions.notAssertion),
    /a question, request or instruction to the reader/u,
  );
});

test("brief-scope v2 reads other work beside the standard and still blocks a dropped criterion", async () => {
  assert.equal(briefScopeBattery.version, 2);
  assert.deepEqual(
    briefScopeBattery.state({ standard: "Task a", brief: "Do a" }),
    {
      standard: "Task a",
      otherWork: "none recorded",
      acceptedExceptions: "none recorded",
      brief: "Do a",
    },
  );
  assert.equal(
    z.object({ otherWork: z.string() }).parse(
      briefScopeBattery.state({
        standard: "Task a",
        otherWork: "- b: claimed by agent:codex",
        brief: "Do a",
      }),
    ).otherWork,
    "- b: claimed by agent:codex",
  );
  const dropped = await runBattery(
    briefScopeBattery,
    { standard: "Task a", otherWork: "- b", brief: "Do half of a" },
    {
      provider: new ScriptedProvider((_battery, questionId) =>
        questionId === "dropsItems" ? 0.8 : 0.1,
      ),
    },
  );
  assert.equal(dropped.decision.block, true);
  assert.equal(dropped.decision.narrows, 0.8);
});

test("other work lists the plan's other tasks with their holders, claimed first, and the task's out-of-scope items", () => {
  const task = (key: string, status: string, issueId = key) => ({
    key,
    title: `Title ${key}`,
    status,
    issueId,
    identifier: `TA-${key.length}${key}`,
  });
  const tasks = [
    task("own", "in_progress"),
    task("free", "pending"),
    task("held", "in_progress"),
    task("done", "complete"),
    task("dropped", "cancelled"),
  ];
  const claims = standardClaims(
    [
      {
        issueId: "held",
        sessionId: "s_2",
        status: "in_progress",
        location: { paths: ["src/held.ts"] },
      },
      {
        issueId: "free",
        sessionId: "s_gone",
        status: "blocked",
        location: { paths: [] },
      },
    ],
    [{ id: "s_2", agentLabel: "agent:codex" }],
  );
  assert.equal(claims[1]?.owner, "session s_gone");
  const text = otherWorkText(tasks, claims.slice(0, 1), new Set(["own"]), [
    "scheduled exports",
    "scheduled exports",
  ]);
  assert.equal(
    text,
    "Other tasks in the plan and who holds them (not this brief's task):\n- held (TA-4held) [in_progress]: Title held. Claimed by agent:codex (session s_2); paths src/held.ts\n- free (TA-4free) [pending]: Title free. Unclaimed\nRecorded as out of scope for this brief's task:\n- scheduled exports",
  );
  assert.equal(
    otherWorkText(tasks, claims.slice(0, 1), new Set()),
    "Tasks other sessions have claimed (not this brief's to do):\n- held (TA-4held) [in_progress]: Title held. Claimed by agent:codex (session s_2); paths src/held.ts",
  );
  assert.equal(otherWorkText(tasks, [], new Set()), undefined);
  const many = Array.from({ length: 70 }, (_, index) =>
    task(`t${index}`, "pending"),
  );
  assert.match(
    otherWorkText(many, [], new Set(["t0"])) ?? "",
    /\n- and 9 more$/u,
  );
});
