/**
 * Server-side AI proposal service (EDIT-4 PR 2). One provider adapter is
 * injected. Credentials stay on the server and never reach the browser. The
 * service validates the request before the provider sees it and validates the
 * response again before anything is returned, so a malformed, unsafe or
 * off-schema answer becomes a typed failure instead of draft content.
 */
import {
  AI_BLOCK_KINDS,
  AI_PROPOSAL_JSON_SCHEMA,
  AI_PROPOSAL_SCHEMA_VERSION,
  type AiProposalRequest,
  type AiProposalResult,
} from "../contracts/ai-proposals.js";
import { validateAiProposal, validateAiRequest } from "../editor/ai-blocks.js";

export type AiProviderOutput =
  | { readonly kind: "proposal"; readonly body: unknown }
  | { readonly kind: "refusal"; readonly message: string };

export interface AiProvider {
  readonly name: string;
  propose(
    request: AiProposalRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<AiProviderOutput>;
}

export interface AiProposalService {
  /** Returns null when the request itself is invalid. */
  propose(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<AiProposalResult | null>;
}

export function createAiProposalService(options: {
  readonly provider: AiProvider;
  readonly timeoutMs?: number;
}): AiProposalService {
  const timeoutMs = options.timeoutMs ?? 25_000;
  return {
    async propose(raw, signal) {
      const request = validateAiRequest(raw);
      if (!request) return null;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const output = await Promise.race([
          options.provider.propose(request, { signal: controller.signal }),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          ),
        ]);
        if (output.kind === "refusal") {
          return {
            status: "refused",
            message:
              output.message.slice(0, 300) || "The request was declined.",
          };
        }
        const checked = validateAiProposal(output.body, request);
        if (!checked.ok) return { status: "invalid", message: checked.reason };
        return { status: "ok", proposal: checked.proposal };
      } catch {
        return timedOut ? { status: "timeout" } : { status: "unavailable" };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ---------------------------------------------------------- fixture provider

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/);

/**
 * Deterministic provider for local work and tests. It never calls a network.
 * Markers in the request text or instruction trigger failure modes:
 * `[[refuse]]`, `[[malformed]]`, `[[bad-link]]`, `[[bad-block]]`, `[[slow]]`
 * and `[[error]]`.
 */
export function createFixtureAiProvider(): AiProvider {
  return {
    name: "fixture",
    async propose(request, { signal }) {
      const probe = `${request.text ?? ""} ${request.instruction ?? ""}`;
      if (probe.includes("[[error]]")) throw new Error("fixture failure");
      if (probe.includes("[[slow]]")) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("aborted");
      }
      if (probe.includes("[[refuse]]"))
        return {
          kind: "refusal",
          message: "The fixture provider declined this request.",
        };
      if (probe.includes("[[malformed]]"))
        return { kind: "proposal", body: { unexpected: true } };
      const make = (title: string | null, blocks: unknown[]) => ({
        kind: "proposal" as const,
        body: {
          schema: AI_PROPOSAL_SCHEMA_VERSION,
          operation: request.operation,
          title,
          blocks,
        },
      });
      if (probe.includes("[[bad-link]]"))
        return make(null, [
          { kind: "paragraph", text: "Read [this](javascript:alert(1))." },
        ]);
      if (probe.includes("[[bad-block]]"))
        return make(null, [{ kind: "table", text: "a | b" }]);
      const text = request.text ?? "";
      const instruction = (request.instruction ?? "").trim();
      switch (request.operation) {
        case "rewrite":
          return make(null, [
            { kind: "paragraph", text: `Rewritten: ${text}` },
          ]);
        case "shorten":
          return make(null, [
            { kind: "paragraph", text: sentences(text)[0] ?? text },
          ]);
        case "change_tone":
          return make(null, [
            { kind: "paragraph", text: `In a ${instruction} tone: ${text}` },
          ]);
        case "translate":
          return make(null, [
            {
              kind: "paragraph",
              text: `Translation into ${instruction}: ${text}`,
            },
          ]);
        case "create_outline":
          return make(null, [
            { kind: "heading2", text: "Background" },
            { kind: "bullet", text: `What ${instruction} is about` },
            { kind: "bullet", text: "[Needs source: add the key facts]" },
            { kind: "heading2", text: "What happened" },
            { kind: "bullet", text: "[Needs quote: add a sourced quotation]" },
          ]);
        case "draft_section":
          return make(null, [
            { kind: "heading3", text: "Draft section" },
            {
              kind: "paragraph",
              text: `A fictional passage about ${instruction}. [Needs source: add a citation]`,
            },
            {
              kind: "paragraph",
              text: "A second fictional paragraph that continues the section.",
            },
          ]);
        case "draft_article":
          return make(`A fictional draft about ${instruction}`.slice(0, 120), [
            {
              kind: "paragraph",
              text: `This fictional article is about ${instruction}.`,
            },
            { kind: "heading2", text: "Background" },
            {
              kind: "paragraph",
              text: "Background written with **placeholders** for facts. [Needs source: add the key facts]",
            },
            { kind: "heading2", text: "What happened" },
            { kind: "bullet", text: "First fictional point" },
            { kind: "bullet", text: "Second fictional point" },
            { kind: "quote", text: "[Needs quote: add a sourced quotation]" },
            { kind: "divider", text: "" },
            {
              kind: "paragraph",
              text: "A closing fictional paragraph.",
            },
          ]);
      }
    },
  };
}

// ----------------------------------------------------------- OpenAI provider

const SYSTEM_PROMPT = `You edit local news drafts for Colorado Watchdog. Reply only with JSON that matches the schema.
Rules:
- Use only these block kinds: ${AI_BLOCK_KINDS.join(", ")}. Block text is one line of inline Markdown (bold, italic, links).
- Never invent facts, quotes, names or citations. Where a fact, quote or source is missing write a labeled placeholder such as [Needs source: what is missing] or [Needs quote: who and about what].
- Selection operations (rewrite, shorten, change_tone, translate) return exactly one block, a null title and keep the meaning and any links. The instruction holds the tone or the target language.
- create_outline returns headings and bullets. draft_section returns a section. draft_article returns a title and a full draft.
- Echo the request operation in the operation field and set schema to ${AI_PROPOSAL_SCHEMA_VERSION}.`;

/** Strict structured outputs reject some JSON Schema keywords, so drop them. */
function strictSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "maxLength" || key === "maxItems") continue;
    out[key] = strictSchema(entry);
  }
  return out;
}

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * Calls the OpenAI Responses API with Structured Outputs. Nothing is stored
 * by the provider (`store: false`). The key is read on the server only.
 */
export function createOpenAiProvider(
  options: OpenAiProviderOptions,
): AiProvider {
  const call = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  return {
    name: "openai",
    async propose(request, { signal }) {
      const response = await call(`${base}/responses`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          store: false,
          input: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(request) },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "ai_proposal_v1",
              strict: true,
              schema: strictSchema(AI_PROPOSAL_JSON_SCHEMA),
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`provider status ${response.status}`);
      const data = (await response.json()) as {
        output?: {
          content?: { type?: string; text?: string; refusal?: string }[];
        }[];
      };
      for (const item of data.output ?? []) {
        for (const part of item.content ?? []) {
          if (part.type === "refusal") {
            return {
              kind: "refusal",
              message: part.refusal ?? "The request was declined.",
            };
          }
        }
      }
      for (const item of data.output ?? []) {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && typeof part.text === "string") {
            try {
              return { kind: "proposal", body: JSON.parse(part.text) };
            } catch {
              return { kind: "proposal", body: null };
            }
          }
        }
      }
      return { kind: "proposal", body: null };
    },
  };
}

/** Builds the configured provider from server settings, or null when unset. */
export function createAiProviderFromEnv(env: {
  readonly AI_PROVIDER?: string;
  readonly OPENAI_API_KEY?: string;
  readonly AI_MODEL?: string;
}): AiProvider | null {
  if (env.AI_PROVIDER === "fixture") return createFixtureAiProvider();
  if (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY && env.AI_MODEL) {
    return createOpenAiProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.AI_MODEL,
    });
  }
  return null;
}
