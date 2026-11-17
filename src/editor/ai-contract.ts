/**
 * AI proposal contract (EDIT-4 PR 2), schema version 1.
 *
 * A proposal is data only. It never changes a draft by itself: the editor
 * shows it, validates it again and applies it to the working draft only when
 * the author accepts. The operations and block types are a closed set so a
 * response outside it is rejected, not interpreted.
 */
export const AI_PROPOSAL_SCHEMA_VERSION = 1 as const;

export const AI_SELECTION_OPERATIONS = [
  "rewrite",
  "shorten",
  "change_tone",
  "translate",
] as const;
export const AI_DRAFT_OPERATIONS = [
  "create_outline",
  "draft_section",
  "draft_article",
] as const;
export const AI_OPERATIONS = [
  ...AI_SELECTION_OPERATIONS,
  ...AI_DRAFT_OPERATIONS,
] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];
export type AiSelectionOperation = (typeof AI_SELECTION_OPERATIONS)[number];

/** Block kinds a proposal may contain. Text is inline Markdown (bold, italic, links). */
export const AI_BLOCK_KINDS = [
  "paragraph",
  "heading2",
  "heading3",
  "quote",
  "bullet",
  "number",
  "divider",
] as const;
export type AiBlockKind = (typeof AI_BLOCK_KINDS)[number];

export const MAX_AI_BLOCKS = 80;
export const MAX_AI_BLOCK_TEXT = 4_000;
export const MAX_AI_SELECTION_TEXT = 8_000;
export const MAX_AI_INSTRUCTION = 1_000;
export const MAX_AI_TOTAL_TEXT = 60_000;

export interface AiProposalRequest {
  readonly schema: typeof AI_PROPOSAL_SCHEMA_VERSION;
  readonly operation: AiOperation;
  /** Inline Markdown of the selected block. Selection operations only. */
  readonly text?: string;
  /** The author's description, tone or language. */
  readonly instruction?: string;
  readonly context: {
    readonly title: string;
    readonly summary: string | null;
  };
}

export interface AiProposalBlock {
  readonly kind: AiBlockKind;
  readonly text: string;
}

export interface AiProposal {
  readonly schema: typeof AI_PROPOSAL_SCHEMA_VERSION;
  readonly operation: AiOperation;
  /** A suggested title. Kept separate from the body. */
  readonly title: string | null;
  readonly blocks: readonly AiProposalBlock[];
}

export type AiProposalResult =
  | { readonly status: "ok"; readonly proposal: AiProposal }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "timeout" }
  | { readonly status: "unavailable" };

/** Label used for the revision that preserves the draft before an accepted edit. */
export const AI_OPERATION_LABELS: Readonly<Record<AiOperation, string>> = {
  rewrite: "Rewrite",
  shorten: "Shorten",
  change_tone: "Change tone",
  translate: "Translate",
  create_outline: "Create outline",
  draft_section: "Draft section",
  draft_article: "Draft article",
};

/** JSON Schema for provider structured outputs. Mirrors `validateAiProposal`. */
export const AI_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "operation", "title", "blocks"],
  properties: {
    schema: { type: "integer", enum: [AI_PROPOSAL_SCHEMA_VERSION] },
    operation: { type: "string", enum: [...AI_OPERATIONS] },
    title: { type: ["string", "null"], maxLength: 200 },
    blocks: {
      type: "array",
      maxItems: MAX_AI_BLOCKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: [...AI_BLOCK_KINDS] },
          text: { type: "string", maxLength: MAX_AI_BLOCK_TEXT },
        },
      },
    },
  },
} as const;
