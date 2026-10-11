// An ordered chain of judgment sources. Each reading goes to the first source
// that is routed for the battery and whose input limits the request fits.
// When a source is unreachable, rate limited or times out, the next one
// answers; an auth failure or an invalid request stops the chain, since the
// next source would not fix a misconfigured one silently.

import { NoSourceError, isTransient } from "../errors.js";
import {
  exceededLimit,
  type EvaluateRequest,
  type Evaluation,
  type InputLimits,
  type ModelInfo,
  type SourceSkip,
  type SystemOneProvider,
} from "../provider.js";

export interface ChainSource {
  readonly provider: SystemOneProvider;
  readonly limits?: InputLimits;
}

/** Battery id to the source ids that answer it, in order. */
export type Routes = ReadonlyMap<string, readonly string[]>;

export class FailoverProvider implements SystemOneProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly #sources: readonly ChainSource[];
  readonly #routes: Routes;

  constructor(sources: readonly ChainSource[], routes: Routes = new Map()) {
    const first = sources[0];
    if (first === undefined)
      throw new NoSourceError("no judgment source is configured");
    this.#sources = sources;
    this.#routes = routes;
    this.id = sources.map((source) => source.provider.id).join(">");
    this.defaultModel = first.provider.defaultModel;
  }

  get sources(): readonly ChainSource[] {
    return this.#sources;
  }

  /** The sources a battery's readings go to, in order. */
  sourcesFor(batteryId: string | undefined): readonly ChainSource[] {
    const route =
      batteryId === undefined ? undefined : this.#routes.get(batteryId);
    if (route === undefined) return this.#sources;
    return route.flatMap((id) =>
      this.#sources.filter((source) => source.provider.id === id),
    );
  }

  async evaluate(request: EvaluateRequest): Promise<Evaluation> {
    const skipped: SourceSkip[] = [];
    let lastError: unknown;
    let onlyLimits = true;
    for (const source of this.sourcesFor(request.batteryId)) {
      const sourceId = source.provider.id;
      const limit = exceededLimit(request, source.limits);
      if (limit !== undefined) {
        skipped.push({ sourceId, reason: limit });
        continue;
      }
      onlyLimits = false;
      try {
        const evaluation = await source.provider.evaluate(request);
        return skipped.length === 0 ? evaluation : { ...evaluation, skipped };
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        skipped.push({
          sourceId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw new NoSourceError(
      `no source answered: ${skipped.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}`,
      onlyLimits && skipped.length > 0,
      { cause: lastError },
    );
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const first = this.#sources[0];
    return first?.provider.listModels ? first.provider.listModels() : [];
  }
}
