import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { serializeJsonLd } from '@/lib/json-ld';
import {
  islandById,
  landscape,
  paperById,
  paperRoleLabel,
  papersCitedBy,
  papersCitedByPaper,
} from '@/lib/paper-catalog';
import { absoluteSiteUrl, paperDetailUrl, SITE_URL } from '@/lib/site-url';

import { CatalogHeader } from '../catalog-header';
import styles from '../papers.module.css';

type PaperPageProps = {
  params: Promise<{ paperId: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return landscape.papers.map((paper) => ({ paperId: paper.id }));
}

function metadataDescription(summary: string) {
  if (summary.length <= 158) return summary;
  const shortened = summary.slice(0, 157).replace(/\s+\S*$/, '');
  return `${shortened}…`;
}

export async function generateMetadata({
  params,
}: PaperPageProps): Promise<Metadata> {
  const { paperId } = await params;
  const paper = paperById.get(paperId);
  if (!paper) return {};

  const description = metadataDescription(paper.summary);
  const canonical = paperDetailUrl(paper.id);
  const socialImage = absoluteSiteUrl('og.png');

  return {
    title: `${paper.title} | LZ High-Recoil Paper Map`,
    description,
    authors: paper.authors.map((name) => ({ name })),
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title: paper.title,
      description,
      type: 'article',
      url: canonical,
      publishedTime: paper.published,
      modifiedTime: paper.updated,
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: 'LZ Paper Map shown as a scientific island atlas',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: paper.title,
      description,
      images: [socialImage],
    },
  };
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

export default async function PaperPage({ params }: PaperPageProps) {
  const { paperId } = await params;
  const paper = paperById.get(paperId);
  if (!paper) notFound();

  const island = islandById.get(paper.primaryIsland);
  const cites = papersCitedByPaper(paper);
  const citedBy = papersCitedBy(paper.id);
  const canonical = paperDetailUrl(paper.id);
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: paper.title,
    description: paper.summary,
    url: canonical,
    isPartOf: {
      '@type': 'CollectionPage',
      name: 'LUX-ZEPLIN 248 keV Paper Map',
      url: SITE_URL,
    },
    mainEntity: {
      '@type': 'ScholarlyArticle',
      headline: paper.title,
      description: paper.summary,
      author: paper.authors.map((name) => ({
        '@type': /\b(?:collaboration|consortium)\b/i.test(name)
          ? 'Organization'
          : 'Person',
        name,
      })),
      datePublished: paper.published,
      dateModified: paper.updated,
      identifier: `arXiv:${paper.arxivId}`,
      sameAs: paper.url,
      keywords: paper.tags,
      citation: cites.map((citedPaper) => paperDetailUrl(citedPaper.id)),
    },
  };

  return (
    <div className={styles.shell}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(articleJsonLd) }}
      />
      <CatalogHeader
        homeHref="../../../"
        mapHref={`../../?paper=${encodeURIComponent(paper.id)}`}
      />
      <main className={styles.paperMain}>
        <article className={styles.paperArticle}>
          <p className={styles.eyebrow}>
            {island?.label} · {paperRoleLabel(paper.role)}
          </p>
          <h1>{paper.title}</h1>
          <p className={styles.authors}>{paper.authors.join(', ')}</p>

          <dl className={styles.facts}>
            <div>
              <dt>Published</dt>
              <dd>{displayDate(paper.published)}</dd>
            </div>
            {paper.updated !== paper.published && (
              <div>
                <dt>Updated</dt>
                <dd>{displayDate(paper.updated)}</dd>
              </div>
            )}
            <div>
              <dt>Identifier</dt>
              <dd>arXiv:{paper.arxivId}</dd>
            </div>
          </dl>

          <div className={styles.primaryLinks}>
            <a href={paper.url} target="_blank" rel="noreferrer">
              Read on arXiv ↗
            </a>
            <a href={`../../?paper=${encodeURIComponent(paper.id)}`}>
              Locate on the map
            </a>
          </div>

          <section className={styles.contentSection}>
            <h2>Why it is here</h2>
            <p>{paper.takeaway}</p>
          </section>

          <section className={styles.contentSection}>
            <h2>Machine-assisted summary</h2>
            <p>{paper.summary}</p>
          </section>

          <div className={styles.tags} aria-label="Paper concepts">
            {paper.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>

          <section className={styles.lineage}>
            <h2>Citation lineage on this map</h2>
            <div className={styles.lineageGrid}>
              <CitationList title="Cites" papers={cites} />
              <CitationList title="Cited by" papers={citedBy} />
            </div>
          </section>

          <p className={styles.note}>
            Metadata comes from arXiv. Summaries and placement are
            machine-assisted; inclusion is not endorsement or peer review.
          </p>
        </article>
      </main>
    </div>
  );
}

function CitationList({
  title,
  papers,
}: {
  title: string;
  papers: Array<(typeof landscape.papers)[number]>;
}) {
  return (
    <section>
      <h3>
        {title} <span>{papers.length}</span>
      </h3>
      {papers.length ? (
        <ul>
          {papers.map((paper) => (
            <li key={paper.id}>
              <a href={paperDetailUrl(paper.id)}>
                <strong>{paper.title}</strong>
                <span>
                  {paper.authors.join(', ')} · {paper.published.slice(0, 4)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>None among papers currently mapped.</p>
      )}
    </section>
  );
}
