import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { BoardError } from "./errors.js";
import type { Board } from "./ledger/board.js";
import { requestSchemas } from "./schemas.js";
import { version } from "./version.js";

export type Ledger = Pick<Board, "call">;

export function createServer(
  board: Ledger,
  projects?: ReadonlySet<string>,
): McpServer {
  const server = new McpServer(
    { name: "vibecheck-linear-jev", version },
    {
      instructions:
        "Coding-agent work ledger on Linear whose reports are checked. Call project_join first; when it returns adoption_required, put its question to the user and join again with adopt as_is or managed. The coordinator publishes the plan with plan_publish (a Linear project with milestones, labels, documents and one issue per task) or adopts existing issues with issue_adopt. Claim a task with work_claim before working on it, report progress, blockers and completion with work_update (a done report that fails its check stays open as held, with the reason), and read project_status with your session_id, which leads with next (your own attention, your claims, the next available task) and the attention list and shows each task as reported and as verified. Read Linear freely through any Linear tools, but change task state only through these tools. This server never executes or schedules work.",
    },
  );
  async function invoke(
    projectId: string,
    call: () => Promise<object>,
  ): Promise<CallToolResult> {
    try {
      if (projects !== undefined && !projects.has(projectId)) {
        throw new BoardError(
          "forbidden",
          "Project is not permitted by this server.",
        );
      }
      const result = { ...(await call()) };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      };
    } catch (error) {
      if (!(error instanceof BoardError))
        process.stderr.write(
          `vibecheck-linear-jev: tool call failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      const result = {
        error:
          error instanceof BoardError
            ? error.asDict()
            : { code: "internal", message: "Internal server error." },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: true,
      };
    }
  }
  const write: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    "project_join",
    {
      description:
        "Join a project with this session's identity; links or creates its Linear project. May return adoption_required with a question for the user.",
      inputSchema: z.object({ request: requestSchemas.project_join }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("project_join", request)),
  );
  server.registerTool(
    "plan_publish",
    {
      description:
        "Publish the coordinator's complete plan as a Linear project: fields, labels, milestones, documents, issues and dependencies. Returns completeness and plan checks.",
      inputSchema: z.object({ request: requestSchemas.plan_publish }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_publish", request)),
  );
  server.registerTool(
    "plan_edit",
    {
      description:
        "Add or update tasks, milestones, documents, labels, links, project fields or policy, using the expected plan revision.",
      inputSchema: z.object({ request: requestSchemas.plan_edit }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_edit", request)),
  );
  server.registerTool(
    "plan_read",
    {
      description:
        "Read a plan revision's task map, or the difference between two revisions.",
      inputSchema: z.object({ request: requestSchemas.plan_read }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_read", request)),
  );
  server.registerTool(
    "plan_ack",
    {
      description: "Record the plan revision this session reviewed.",
      inputSchema: z.object({ request: requestSchemas.plan_ack }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_ack", request)),
  );
  server.registerTool(
    "issue_adopt",
    {
      description:
        "Read an existing Linear issue as a task under a plan key; reports its missing sections and vague standard.",
      inputSchema: z.object({ request: requestSchemas.issue_adopt }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("issue_adopt", request)),
  );
  server.registerTool(
    "work_claim",
    {
      description:
        "Claim a task (plan key or issue identifier); the earliest claim in Linear wins.",
      inputSchema: z.object({ request: requestSchemas.work_claim }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_claim", request)),
  );
  server.registerTool(
    "work_update",
    {
      description:
        "Report progress, blockers, completion, release or handoff of claimed work; done reports are checked before the issue moves to done.",
      inputSchema: z.object({ request: requestSchemas.work_update }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_update", request)),
  );
  server.registerTool(
    "project_status",
    {
      description:
        "What to do now (next: with session_id, your own attention items, your open claims, then the next available task), current tasks as reported and as verified, open work, sessions and the attention list.",
      inputSchema: z.object({ request: requestSchemas.project_status }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("project_status", request)),
  );
  server.registerTool(
    "work_history",
    {
      description:
        "Work, Linear comments and verification history by task, session, path, branch or commit.",
      inputSchema: z.object({ request: requestSchemas.work_history }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_history", request)),
  );
  server.registerTool(
    "project_update",
    {
      description:
        "Post a Linear project update; the body is drafted from verified status when omitted.",
      inputSchema: z.object({ request: requestSchemas.project_update }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("project_update", request)),
  );
  return server;
}

export interface HttpOptions {
  token: string;
  host?: string;
  allowedHosts?: readonly string[];
  projects?: ReadonlySet<string>;
}

function validHostAuthority(host: string): boolean {
  const match = /^(\[[^\]]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(host);
  const hostname = match?.[1];
  const port = match?.[2];
  if (
    hostname === undefined ||
    (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
  )
    return false;
  if (hostname.startsWith("[")) return isIP(hostname.slice(1, -1)) === 6;
  if (/^[0-9.]+$/.test(hostname)) return isIP(hostname) === 4;
  return (
    hostname.length <= 253 &&
    hostname
      .replace(/\.$/, "")
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      )
  );
}

export function matchesHost(
  host: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (!host || !validHostAuthority(host)) return false;
  return allowedHosts.some(
    (allowed) =>
      allowed === host ||
      (allowed.endsWith(":*") && host.startsWith(allowed.slice(0, -1))),
  );
}

function headerCount(request: IncomingMessage, name: string): number {
  return request.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === name,
  ).length;
}

export function bearerGate(
  token: string,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  if (!token || /\s/u.test(token))
    throw new Error(
      "VIBECHECK_LINEAR_JEV_TOKEN must be nonempty and contain no whitespace.",
    );
  const expected = Buffer.from(token);
  return (request, response) => {
    const authorization =
      headerCount(request, "authorization") === 1
        ? request.headers.authorization
        : undefined;
    const separator = authorization?.indexOf(" ") ?? -1;
    const scheme = authorization?.slice(0, separator).toLowerCase();
    const supplied = Buffer.from(authorization?.slice(separator + 1) ?? "");
    if (
      scheme === "bearer" &&
      separator > 0 &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    )
      return true;
    response.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
    });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  };
}

export function createHttpApp(board: Ledger, options: HttpOptions) {
  const authenticate = bearerGate(options.token);
  const host = options.host ?? "127.0.0.1";
  const allowedHosts = [
    "127.0.0.1",
    "127.0.0.1:*",
    "localhost",
    "localhost:*",
    "[::1]",
    "[::1]:*",
  ];
  if (host !== "0.0.0.0" && host !== "::") {
    const value =
      host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    allowedHosts.push(value, `${value}:*`);
  }
  allowedHosts.push(...(options.allowedHosts ?? []));
  const handler = createMcpHandler(
    () => createServer(board, options.projects),
    { legacy: "reject" },
  );
  const legacyServers = new Set<McpServer>();
  const nodeHandler = toNodeHandler({
    async fetch(request: Request): Promise<Response> {
      if (
        request.method === "POST" &&
        !isJsonContentType(request.headers.get("content-type"))
      ) {
        return new Response("Unsupported Content-Type", { status: 415 });
      }
      if (!(await isLegacyRequest(request))) return handler.fetch(request);
      if (request.method === "GET" || request.method === "DELETE") {
        return new Response("Method not allowed.", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      const legacy = createServer(board, options.projects);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      legacyServers.add(legacy);
      const abort = () => {
        void legacy.close().catch(() => {});
      };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        await legacy.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        request.signal.removeEventListener("abort", abort);
        legacyServers.delete(legacy);
        await legacy.close();
      }
    },
  });
  const validateOrigin = originValidation([]);
  const server = createHttpServer((request, response) => {
    if (!authenticate(request, response)) return;
    if (
      headerCount(request, "host") !== 1 ||
      !matchesHost(request.headers.host, allowedHosts)
    ) {
      response.writeHead(421, { "Content-Type": "text/plain" });
      response.end("Invalid Host header");
      return;
    }
    if (!validateOrigin(request, response)) return;
    const path = request.url?.split("?")[0];
    if (path !== "/mcp" && path !== "/mcp/") {
      response.writeHead(404);
      response.end();
      return;
    }
    void nodeHandler(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    ).catch(() => {
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded)
        response.end(JSON.stringify({ error: "Internal server error." }));
    });
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      closing ??= (async () => {
        await handler.close();
        await Promise.all([...legacyServers].map((legacy) => legacy.close()));
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
      })();
      return closing;
    },
  };
}
