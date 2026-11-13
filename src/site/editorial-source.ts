/**
 * Presentation model for the public Story and Post templates.
 *
 * This is not a publication contract. No publishing lifecycle exists yet, so
 * the production site uses `emptyEditorialSource` and never reads the
 * editorial tables, whose records are drafts or archived. The local preview
 * injects clearly fictional fixtures to demonstrate the templates.
 */
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
  readonly related: {
    readonly counties: readonly { fips: string; name: string }[];
    readonly people: readonly { id: string; displayName: string }[];
    readonly organizations: readonly { id: string; name: string }[];
  };
  readonly sources: readonly { title: string; url: string }[];
}

export interface EditorialSource {
  list(type: EditorialType): readonly EditorialArticle[];
  get(type: EditorialType, slug: string): EditorialArticle | null;
}

export const emptyEditorialSource: EditorialSource = {
  list: () => [],
  get: () => null,
};
