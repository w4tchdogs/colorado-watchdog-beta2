import { ARTICLE_SLUG } from "../contracts/publication.js";
import type { AsyncD1Database } from "../database/d1.js";
import { validPublicationMetadata } from "../services/content-publication.js";
import { personIsPublicSql } from "../services/person-visibility.js";
import type {
  EditorialArticle,
  EditorialSource,
  EditorialType,
} from "./editorial-source.js";

interface PublishedRow {
  slug: string;
  published_at: string;
  title: string;
  summary: string | null;
  body: string;
  metadata_json: string;
  counties: string;
  people: string;
  organizations: string;
}

const PAGE_SIZE = 25;
const PUBLIC_FROM = `FROM content_publications p JOIN content_revisions r
    ON r.content_id=p.content_id AND r.version=p.revision_version
  WHERE p.withdrawn_at IS NULL AND r.status='draft' AND p.content_type=?`;
const CARD = `p.slug,p.published_at,r.title,r.summary,p.metadata_json`;
const PROJECTION = `SELECT ${CARD},r.body,
  (SELECT json_group_array(json_object('fips',c.fips,'name',c.name))
     FROM json_each(r.county_fips_json) j JOIN counties c ON c.fips=j.value) AS counties,
  (SELECT json_group_array(json_object('id',person.id,'displayName',person.display_name))
     FROM json_each(r.person_ids_json) j JOIN people person ON person.id=j.value
     WHERE ${personIsPublicSql("person.id")}) AS people,
  (SELECT json_group_array(json_object('id',o.id,'name',o.name))
     FROM json_each(r.organization_ids_json) j JOIN organizations o ON o.id=j.value) AS organizations
  ${PUBLIC_FROM}`;

function article(row: PublishedRow, type: EditorialType): EditorialArticle {
  const metadata: unknown = JSON.parse(row.metadata_json);
  if (!validPublicationMetadata(metadata))
    throw new Error("Invalid public editorial metadata");
  return {
    type,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? "",
    date: row.published_at.slice(0, 10),
    fictional: false,
    ...metadata,
    sources: metadata.sources ?? [],
    body: [],
    markdown: row.body,
    related: {
      counties: JSON.parse(row.counties),
      people: JSON.parse(row.people),
      organizations: JSON.parse(row.organizations),
    },
  };
}

export function createD1EditorialSource(
  database: AsyncD1Database,
): EditorialSource {
  return {
    async list(type) {
      try {
        const articles: EditorialArticle[] = [];
        let after = "";
        // Slugs are permanent and make this cursor stable across republishes.
        for (;;) {
          const rows = await database.all<PublishedRow>(
            `${PROJECTION} AND p.slug>? ORDER BY p.slug`,
            PAGE_SIZE,
            [type, after],
          );
          articles.push(...rows.map((row) => article(row, type)));
          const last = rows.at(-1);
          if (!last || rows.length < PAGE_SIZE) break;
          after = last.slug;
        }
        return articles.sort(
          (a, b) =>
            b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
        );
      } catch {
        // An unavailable binding or missing migration never falls back to draft data.
        return [];
      }
    },
    async previews(type, limit) {
      try {
        const rows = await database.all<PublishedRow>(
          `SELECT ${CARD},'' AS body,'[]' AS counties,'[]' AS people,'[]' AS organizations
           ${PUBLIC_FROM} ORDER BY p.published_at DESC,p.slug`,
          limit,
          [type],
        );
        return rows.map((row) => article(row, type));
      } catch {
        return [];
      }
    },
    async get(type, slug) {
      if (!ARTICLE_SLUG.test(slug)) return null;
      try {
        const row = await database.first<PublishedRow>(
          `${PROJECTION} AND p.slug=?`,
          [type, slug],
        );
        return row ? article(row, type) : null;
      } catch {
        return null;
      }
    },
  };
}
