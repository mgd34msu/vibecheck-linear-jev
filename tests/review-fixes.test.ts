import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { SqliteLocalStore } from "../src/local/store.js";
import { appendEntry } from "../src/verification/store.js";
import {
  PROJECT,
  PROJECT_KEY,
  claim,
  createLedger,
  join as joinSession,
  publish,
  request,
} from "./helpers.js";

const configHome = mkdtempSync(
  join(tmpdir(), "vibecheck-linear-jev-review-config-"),
);
process.on("exit", () => rmSync(configHome, { recursive: true, force: true }));
const cliPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../src/cli.ts" : "../src/cli.js",
    import.meta.url,
  ),
);

test("a failure outside the ledger's own errors reaches stderr and stays sanitized for the client", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-linear-jev-hidden-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace.json");
  writeFileSync(workspace, "this is not a workspace");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--database", join(directory, "state.sqlite3")],
    env: {
      XDG_CONFIG_HOME: configHome,
      PATH: process.env["PATH"] ?? "",
      VIBECHECK_LINEAR_JEV_LINEAR_BACKEND: "memory",
      VIBECHECK_LINEAR_JEV_MEMORY_FILE: workspace,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "hidden-errors", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({
    name: "project_join",
    arguments: {
      request: {
        project_id: "p",
        request_id: "r",
        repository: "repo",
        vendor: "v",
        runtime: "r",
        external_session_id: "e",
        model: "m",
      },
    },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "internal", message: "Internal server error." },
  });
  await client.close();
  assert.match(stderr, /tool call failed: .*JSON/u);
});

test("commit SHAs are stored lower-case and found by either case", async (t) => {
  const { board } = createLedger(t);
  const session = await joinSession(board);
  await publish(board, session, [{ key: "A-1", title: "A" }]);
  const claimed = await claim(board, session, "A-1", { target_branch: "main" });
  const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const updated = z
    .object({
      work: z.array(
        z.object({ commit: z.string().nullable(), status: z.string() }),
      ),
    })
    .parse(
      await board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        updates: [
          {
            work_id: claimed.work.id,
            status: "awaiting_integration",
            commit: upper,
          },
        ],
      }),
    );
  assert.equal(updated.work[0]?.commit, upper.toLowerCase());
  assert.equal(updated.work[0]?.status, "awaiting_integration");
  for (const commit of [upper, upper.toLowerCase()]) {
    const found = z
      .object({ work: z.array(z.object({ id: z.string() })) })
      .parse(await board.call("work_history", { project_id: PROJECT, commit }));
    assert.deepEqual(
      found.work.map((work) => work.id),
      [claimed.work.id],
    );
  }
});

test("a failed transaction leaves no partial rows", (t) => {
  const { store } = createLedger(t);
  assert.throws(
    () =>
      store.transaction(() => {
        store.enqueue({ projectKey: null, kind: "comment", payload: {} });
        throw new Error("original failure");
      }),
    /original failure/u,
  );
  assert.equal(store.pendingCount(), 0);
});

test("history cannot be rewritten or deleted", (t) => {
  const { path, store } = createLedger(t);
  appendEntry(
    store.verificationAccess(),
    { projectId: null },
    { kind: "label", body: { verdict_id: "v_1", right: true, note: "" } },
  );
  const connection = new Database(path);
  try {
    assert.throws(
      () => connection.exec("UPDATE verifications SET kind = 'x'"),
      /history is immutable/u,
    );
    assert.throws(
      () => connection.exec("DELETE FROM verifications"),
      /history is immutable/u,
    );
  } finally {
    connection.close();
  }
});

test("idempotency receipts older than the retention window are pruned on write", async (t) => {
  const { board, path, store } = createLedger(t);
  const old = new SqliteLocalStore(path, {
    now: () => new Date("2000-01-01T00:00:00.000Z"),
  });
  old.putReceipt("old-scope", "r-old", "hash", { stale: true });
  old.close();
  const session = await joinSession(board);
  await board.call("plan_ack", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    plan_revision: 0,
  });
  assert.equal(store.receipt("old-scope", "r-old"), undefined);
  assert.ok(store.project(PROJECT_KEY) !== undefined);
});
