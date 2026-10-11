// Laya, the open-source Jev-compatible model, served locally.
//
//   laya install   installs @receptron/laya and its native ONNX Runtime
//                  dependency into the data folder (never the plugin folder)
//   laya serve     loads the model once and answers POST /v1/systemone and
//                  GET /v1/models on localhost in the TypeSafe wire shape
//
// A "laya" source then connects over HTTP like any open Jev server, so hooks
// never load the 1.7 GB of weights themselves. The native addon is never
// bundled: the server imports Laya from the data folder at run time. ONNX
// Runtime's addon loads and runs under both Bun and Node.js.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { layaDirectory } from "../paths.js";
import {
  DEFAULT_LAYA_PORT,
  sourcesOf,
  type Config,
  type SourceConfig,
} from "./config.js";
import { parse, UsageError, type ToolIO } from "./tools/common.js";

export const LAYA_PACKAGE = "@receptron/laya@0.1.2";

/** What the server needs from a loaded model: one System One call and a way to release it. */
export interface SystemOneModel {
  readonly name: string;
  systemOne(
    state: unknown,
    questions: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  close(): Promise<void>;
}

const requestSchema = z.object({
  state: z.unknown(),
  questions: z.record(
    z.string(),
    z.looseObject({ type: z.enum(["noul", "choice", "score"]) }),
  ),
  model: z.string().optional(),
});

const unit = z.number().min(0).max(1);
const wireAnswerSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("noul"), noul: unit }),
  z.looseObject({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: unit,
    probabilities: z.record(z.string(), unit),
  }),
  z.looseObject({
    type: z.literal("score"),
    score: z.number(),
    confidence: unit,
    probabilities: z.record(z.string(), unit),
    legend: z.record(z.string(), z.unknown()).optional(),
  }),
]);
const resultSchema = z.looseObject({
  model: z.string().optional(),
  answers: z.record(z.string(), wireAnswerSchema),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number().optional(),
  }),
});

/** A model result in the TypeSafe wire shape: answers without model-specific extras. */
export function toWire(result: unknown, model: string): unknown {
  const parsed = resultSchema.parse(result);
  const answers: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(parsed.answers)) {
    switch (answer.type) {
      case "noul":
        answers[id] = { type: "noul", noul: answer.noul };
        break;
      case "choice":
        answers[id] = {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
        };
        break;
      case "score":
        answers[id] = {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          legend: answer.legend ?? {},
        };
        break;
    }
  }
  return {
    model: parsed.model ?? model,
    answers,
    usage: {
      input_tokens: parsed.usage.input_tokens,
      output_tokens: parsed.usage.output_tokens ?? 0,
    },
  };
}

const BODY_LIMIT = 8 * 1024 * 1024;

/** An HTTP server that answers the System One wire API from one loaded model. */
export function createSystemOneServer(model: SystemOneModel): Server {
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/v1/models") {
      send(200, {
        models: [
          {
            name: model.name,
            description: "Laya served locally by vibecheck-linear-jev",
            release_date: "",
          },
        ],
      });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/systemone") {
      send(404, { error: "not found" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > BODY_LIMIT) {
        send(413, { error: "request too large" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { error: "body is not JSON" });
        return;
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) {
        send(422, {
          error: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        return;
      }
      model
        .systemOne(parsed.data.state, parsed.data.questions)
        .then((result) => send(200, toWire(result, model.name)))
        .catch((error: unknown) =>
          send(500, {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    });
  });
}

function method(
  target: unknown,
  name: string,
): ((...args: unknown[]) => Promise<unknown>) | undefined {
  if (
    (typeof target !== "object" && typeof target !== "function") ||
    target === null
  )
    return undefined;
  const value: unknown = Reflect.get(target, name);
  if (typeof value !== "function") return undefined;
  return async (...args: unknown[]): Promise<unknown> =>
    Reflect.apply(value, target, args);
}

/** Loads Laya from the data folder with the source's load options. */
export async function loadLaya(
  directory: string,
  source: Extract<SourceConfig, { kind: "laya" }>,
): Promise<SystemOneModel> {
  const entry = join(
    directory,
    "node_modules",
    "@receptron",
    "laya",
    "dist",
    "index.js",
  );
  if (!existsSync(entry))
    throw new UsageError(
      `Laya is not installed in ${directory}; run: vibecheck-linear-jev laya install`,
    );
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const layaClass: unknown =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "Laya")
      : undefined;
  const load = method(layaClass, "load");
  if (load === undefined)
    throw new Error("the installed Laya package has no Laya.load");
  const options = source.load ?? {};
  const instance = await load({
    ...(options.modelDir === undefined ? {} : { modelDir: options.modelDir }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.subfolder === undefined
      ? {}
      : { subfolder: options.subfolder }),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.executionProviders === undefined
      ? {}
      : { executionProviders: options.executionProviders }),
    ...(options.intraOpNumThreads === undefined
      ? {}
      : { sessionOptions: { intraOpNumThreads: options.intraOpNumThreads } }),
  });
  const systemOne = method(instance, "systemOne");
  const close = method(instance, "close");
  if (systemOne === undefined || close === undefined)
    throw new Error("the loaded Laya model has no systemOne or close");
  return {
    name: source.model ?? "laya",
    systemOne: (state, questions) => systemOne(state, questions),
    close: async () => {
      await close();
    },
  };
}

function layaSource(
  config: Config,
  id: string | undefined,
): Extract<SourceConfig, { kind: "laya" }> {
  const found = sourcesOf(config).find(
    (source): source is Extract<SourceConfig, { kind: "laya" }> =>
      source.kind === "laya" && (id === undefined || source.id === id),
  );
  return found ?? { kind: "laya", id: id ?? "laya" };
}

export async function layaCommand(
  args: string[],
  io: ToolIO & { readonly config: Config },
): Promise<number> {
  const [verb, ...rest] = args;
  const directory = layaDirectory(io.env);
  if (verb === "install") {
    mkdirSync(directory, { recursive: true });
    io.out(`installing ${LAYA_PACKAGE} into ${directory}`);
    const result = spawnSync(
      "npm",
      [
        "install",
        "--prefix",
        directory,
        "--no-audit",
        "--no-fund",
        LAYA_PACKAGE,
      ],
      {
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      io.err("npm install failed; Laya needs Node.js 20 or newer and npm");
      return 1;
    }
    io.out("installed; start it with: vibecheck-linear-jev laya serve");
    return 0;
  }
  if (verb !== "serve")
    throw new UsageError(
      "usage: laya install | laya serve [--source ID] [--port N] [--host H]",
    );
  const { values } = parse(rest, {
    source: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
  });
  const source = layaSource(io.config, values.source);
  const port = Number(values.port ?? source.port ?? DEFAULT_LAYA_PORT);
  const host = values.host ?? source.host ?? "127.0.0.1";
  io.out(`loading Laya (the first run downloads about 1.7 GB of weights)`);
  const model = await loadLaya(directory, source);
  const server = createSystemOneServer(model);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  io.out(`Laya is answering on http://${host}:${port}/v1/systemone`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await model.close();
  return 0;
}
