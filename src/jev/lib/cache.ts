// Request cache keyed by the canonical request hash. A judgment model is
// self-consistent across repeats, so a cached answer is as good as a fresh one
// for the same model, questions and state. Hits keep the original source,
// latency and usage so a reading still shows what it cost when first asked.

import { requestHash } from "./hash.js";
import type {
  EvaluateRequest,
  Evaluation,
  ModelInfo,
  SystemOneProvider,
} from "./provider.js";

/** Bounded in-memory store with least-recently-used eviction. */
export class LruCache {
  readonly #map = new Map<string, Evaluation>();
  readonly #maxEntries: number;

  constructor(maxEntries = 5_000) {
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): Evaluation | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry;
  }

  set(key: string, value: Evaluation): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;
      this.#map.delete(oldest.value);
    }
  }
}

export class CachingProvider implements SystemOneProvider {
  readonly id: string;
  readonly defaultModel: string;
  readonly #inner: SystemOneProvider;
  readonly #store: LruCache;
  #hits = 0;
  #misses = 0;

  constructor(inner: SystemOneProvider, store: LruCache = new LruCache()) {
    this.#inner = inner;
    this.#store = store;
    this.id = inner.id;
    this.defaultModel = inner.defaultModel;
  }

  get stats(): { readonly hits: number; readonly misses: number } {
    return { hits: this.#hits, misses: this.#misses };
  }

  async evaluate(request: EvaluateRequest): Promise<Evaluation> {
    const key = requestHash({
      model: `${request.batteryId ?? ""}|${request.model ?? this.defaultModel}`,
      questions: request.questions,
      state: request.state,
    });
    const hit = this.#store.get(key);
    if (hit !== undefined) {
      this.#hits += 1;
      return { ...hit, provenance: "cache" };
    }
    this.#misses += 1;
    const evaluation = await this.#inner.evaluate(request);
    this.#store.set(key, evaluation);
    return evaluation;
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.#inner.listModels ? this.#inner.listModels() : [];
  }
}
