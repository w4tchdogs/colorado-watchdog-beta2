/** Presentation model for public Story and Post templates. */
import type {
  EditorialLabel,
  EditorialPathway,
} from "../contracts/publication.js";

export type {
  EditorialLabel,
  EditorialPathway,
} from "../contracts/publication.js";
export type EditorialType = "story" | "post";

export type ArticleBlock =
  | { readonly kind: "paragraph" | "heading" | "quote"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] };

export interface EditorialArticle {
  readonly type: EditorialType;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** Stored calendar date (YYYY-MM-DD). */
  readonly date: string;
  readonly byline: string;
  /** True for local-preview demonstration fixtures. */
  readonly fictional: boolean;
  readonly body: readonly ArticleBlock[];
  readonly markdown?: string;
  readonly related: {
    readonly counties: readonly { fips: string; name: string }[];
    readonly people: readonly { id: string; displayName: string }[];
    readonly organizations: readonly { id: string; name: string }[];
  };
  readonly sources: readonly { title: string; url: string }[];
  /**
   * Optional presentation metadata. Absent means the article is unclassified.
   * Unclassified articles never match a pathway, series or topic filter.
   */
  readonly pathway?: EditorialPathway;
  readonly series?: EditorialLabel;
  readonly topics?: readonly EditorialLabel[];
}

export interface EditorialSource {
  list(
    type: EditorialType,
  ): readonly EditorialArticle[] | Promise<readonly EditorialArticle[]>;
  /** If provided, reads only the newest cards needed for the homepage. */
  previews?(
    type: EditorialType,
    limit: number,
  ): Promise<readonly EditorialArticle[]>;
  get(
    type: EditorialType,
    slug: string,
  ): EditorialArticle | null | Promise<EditorialArticle | null>;
}

export const emptyEditorialSource: EditorialSource = {
  list: () => [],
  get: () => null,
};
