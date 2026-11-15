export const CONTENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const ARTICLE_SLUG = /^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const EDITORIAL_PATHWAYS = [
  "local-series",
  "guest-voices",
  "statewide-issues",
] as const;
export type EditorialPathway = (typeof EDITORIAL_PATHWAYS)[number];

export interface EditorialLabel {
  readonly slug: string;
  readonly label: string;
}

export interface PublicationMetadata {
  readonly byline: string;
  readonly sources?: readonly { title: string; url: string }[];
  readonly pathway?: EditorialPathway;
  readonly series?: EditorialLabel;
  readonly topics?: readonly EditorialLabel[];
}

export interface PublicationRequest {
  readonly id: string;
  readonly expectedVersion: number;
  readonly expectedPublicationVersion: number;
}

export interface PublishRequest extends PublicationRequest {
  readonly slug: string;
  readonly metadata: PublicationMetadata;
}

export interface PublicationReceipt {
  readonly contentId: string;
  readonly slug: string;
  readonly publicationVersion: number;
  readonly revisionVersion: number;
  readonly status: "published" | "withdrawn";
}
