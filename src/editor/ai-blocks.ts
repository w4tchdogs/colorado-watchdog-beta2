/**
 * Validation and block conversion for AI proposals. Pure and dependency free,
 * so the server and the browser enforce the same rules. A proposal is accepted
 * only when every block converts to a supported editor block and the whole
 * result survives the visual Markdown round trip, which also rejects unsafe
 * link targets.
 */
import {
  AI_BLOCK_KINDS,
  AI_DRAFT_OPERATIONS,
  AI_OPERATIONS,
  AI_PROPOSAL_SCHEMA_VERSION,
  AI_SELECTION_OPERATIONS,
  type AiBlockKind,
  type AiOperation,
  type AiProposal,
  type AiProposalRequest,
  MAX_AI_BLOCK_TEXT,
  MAX_AI_BLOCKS,
  MAX_AI_INSTRUCTION,
  MAX_AI_SELECTION_TEXT,
  MAX_AI_TOTAL_TEXT,
} from "./ai-contract.js";
import {
  roundTrips,
  toVisual,
  type VBlock,
  type VKind,
} from "./visual-model.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x0a) || code === 0x7f;
  });

const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function validateAiRequest(value: unknown): AiProposalRequest | null {
  if (!isRecord(value)) return null;
  if (!closed(value, ["schema", "operation", "text", "instruction", "context"]))
    return null;
  if (value.schema !== AI_PROPOSAL_SCHEMA_VERSION) return null;
  const operation = value.operation as AiOperation;
  if (!AI_OPERATIONS.includes(operation)) return null;
  const context = value.context;
  if (
    !isRecord(context) ||
    !closed(context, ["title", "summary"]) ||
    typeof context.title !== "string" ||
    context.title.length > 1_200 ||
    hasControl(context.title) ||
    !(
      context.summary === null ||
      (typeof context.summary === "string" &&
        context.summary.length <= 1_000 &&
        !hasControl(context.summary))
    )
  )
    return null;
  const text = value.text;
  const instruction = value.instruction;
  if (
    text !== undefined &&
    (typeof text !== "string" ||
      text.length > MAX_AI_SELECTION_TEXT ||
      hasControl(text))
  )
    return null;
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" ||
      instruction.trim().length === 0 ||
      instruction.length > MAX_AI_INSTRUCTION ||
      hasControl(instruction))
  )
    return null;
  const selection = (AI_SELECTION_OPERATIONS as readonly string[]).includes(
    operation,
  );
  if (selection) {
    if (typeof text !== "string" || text.trim().length === 0) return null;
    const needsInstruction =
      operation === "change_tone" || operation === "translate";
    if (needsInstruction && instruction === undefined) return null;
  } else {
    if (text !== undefined) return null;
    if (instruction === undefined) return null;
  }
  return value as unknown as AiProposalRequest;
}

const KIND_MAP: Readonly<Record<AiBlockKind, { prefix: string; kind: VKind }>> =
  {
    paragraph: { prefix: "", kind: "p" },
    heading2: { prefix: "## ", kind: "h2" },
    heading3: { prefix: "### ", kind: "h3" },
    quote: { prefix: "> ", kind: "quote" },
    bullet: { prefix: "- ", kind: "ul" },
    number: { prefix: "1. ", kind: "ol" },
    divider: { prefix: "", kind: "hr" },
  };

export type ProposalBlocks =
  | { readonly ok: true; readonly blocks: VBlock[] }
  | { readonly ok: false; readonly reason: string };

/** Converts proposal blocks to editor blocks, or explains the first problem. */
export function proposalBlocksToVisual(
  blocks: readonly { readonly kind: AiBlockKind; readonly text: string }[],
): ProposalBlocks {
  const out: VBlock[] = [];
  let total = 0;
  for (const [index, block] of blocks.entries()) {
    const spec = KIND_MAP[block.kind];
    const where = `Block ${index + 1}`;
    if (block.kind === "divider") {
      if (block.text !== "")
        return { ok: false, reason: `${where} is a divider with text` };
      out.push({ kind: "hr", text: [] });
      continue;
    }
    const text = block.text.trim();
    total += text.length;
    if (text.length === 0 || /[\r\n]/.test(text) || hasControl(text))
      return { ok: false, reason: `${where} is empty or has line breaks` };
    const result = toVisual(`${spec.prefix}${text}`);
    const only = result.ok ? result.blocks[0] : undefined;
    if (!result.ok || result.blocks.length !== 1 || only?.kind !== spec.kind) {
      return {
        ok: false,
        reason: `${where} uses ${result.ok ? "formatting that changes its type" : result.reason}`,
      };
    }
    out.push(only);
  }
  if (total > MAX_AI_TOTAL_TEXT)
    return { ok: false, reason: "The proposal is too long" };
  if (!roundTrips(out))
    return {
      ok: false,
      reason: "The proposal does not convert to Markdown that reads the same",
    };
  return { ok: true, blocks: out };
}

export type ValidatedProposal =
  | {
      readonly ok: true;
      readonly proposal: AiProposal;
      readonly blocks: VBlock[];
    }
  | { readonly ok: false; readonly reason: string };

/** Checks a provider response against the request and the supported blocks. */
export function validateAiProposal(
  value: unknown,
  request: AiProposalRequest,
): ValidatedProposal {
  const bad = (reason: string): ValidatedProposal => ({ ok: false, reason });
  if (
    !isRecord(value) ||
    !closed(value, ["schema", "operation", "title", "blocks"])
  )
    return bad("The response is not a proposal");
  if (value.schema !== AI_PROPOSAL_SCHEMA_VERSION)
    return bad("The proposal uses an unknown schema version");
  if (value.operation !== request.operation)
    return bad("The proposal answers a different operation");
  const title = value.title;
  if (
    !(
      title === null ||
      (typeof title === "string" && title.length <= 200 && !hasControl(title))
    )
  )
    return bad("The suggested title is not valid");
  const raw = value.blocks;
  if (!Array.isArray(raw) || raw.length > MAX_AI_BLOCKS)
    return bad("The proposal has no valid block list");
  const blocks: { kind: AiBlockKind; text: string }[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !closed(entry, ["kind", "text"]) ||
      !AI_BLOCK_KINDS.includes(entry.kind as AiBlockKind) ||
      typeof entry.text !== "string" ||
      entry.text.length > MAX_AI_BLOCK_TEXT
    )
      return bad("The proposal contains a block that is not supported");
    blocks.push({ kind: entry.kind as AiBlockKind, text: entry.text });
  }
  const selection = (AI_SELECTION_OPERATIONS as readonly string[]).includes(
    request.operation,
  );
  if (selection) {
    const only = blocks[0];
    if (blocks.length !== 1 || !only || only.kind === "divider")
      return bad("A selection edit must return exactly one text block");
    if (title !== null) return bad("A selection edit cannot suggest a title");
  } else {
    if (blocks.length === 0) return bad("The proposal has no blocks");
    if (!(AI_DRAFT_OPERATIONS as readonly string[]).includes(request.operation))
      return bad("Unknown operation");
  }
  const converted = proposalBlocksToVisual(blocks);
  if (!converted.ok) return bad(converted.reason);
  return {
    ok: true,
    proposal: {
      schema: AI_PROPOSAL_SCHEMA_VERSION,
      operation: request.operation,
      title,
      blocks,
    },
    blocks: converted.blocks,
  };
}
