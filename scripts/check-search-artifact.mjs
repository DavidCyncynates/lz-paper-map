import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SITE_URL, sitemapEntries } from './search-discovery.mjs';

const projectRoot = process.cwd();
const outputRoot = join(projectRoot, 'dist', 'client');
const catalog = JSON.parse(
  readFileSync(join(projectRoot, 'data', 'landscape.json'), 'utf8'),
);
const expectedEntries = sitemapEntries(
  catalog,
  process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL,
);

function readOutput(...segments) {
  const path = join(outputRoot, ...segments);
  assert.ok(existsSync(path), `Missing search artifact: ${path}`);
  return readFileSync(path, 'utf8');
}

function canonicalFrom(html, label) {
  const matches = [
    ...html.matchAll(/<link rel="canonical" href="([^"]+)"\/?>(?:<\/link>)?/g),
  ];
  assert.equal(matches.length, 1, `${label} must have one canonical link`);
  return matches[0][1];
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function titleFrom(html, label) {
  const value = html.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.ok(value, `${label} needs a title`);
  return decodeEntities(value);
}

function metaContent(html, attribute, value, label) {
  const tag = [...html.matchAll(/<meta\b[^>]*>/g)]
    .map((match) => match[0])
    .find((candidate) => candidate.includes(`${attribute}="${value}"`));
  assert.ok(tag, `${label} needs ${attribute}="${value}" metadata`);
  const content = tag.match(/\bcontent="([^"]*)"/)?.[1];
  assert.notEqual(content, undefined, `${label} metadata needs content`);
  return decodeEntities(content);
}

function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonLdDocuments(html, label) {
  const documents = [
    ...html.matchAll(
      /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map((match, index) => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      assert.fail(`${label} JSON-LD ${index + 1} is invalid: ${String(error)}`);
    }
  });
  assert.ok(documents.length, `${label} needs JSON-LD`);
  return documents;
}

function findJsonLdType(value, type) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findJsonLdType(item, type);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const candidateTypes = Array.isArray(value['@type'])
    ? value['@type']
    : [value['@type']];
  if (candidateTypes.includes(type)) return value;
  for (const child of Object.values(value)) {
    const match = findJsonLdType(child, type);
    if (match) return match;
  }
  return null;
}

const rootHtml = readOutput('index.html');
const rootCanonical = canonicalFrom(rootHtml, 'Map root');
const rootTitle = titleFrom(rootHtml, 'Map root');
const rootDescription = metaContent(
  rootHtml,
  'name',
  'description',
  'Map root',
);
const rootVisibleText = visibleText(rootHtml);
const rootSearchText = `${rootTitle} ${rootDescription} ${rootVisibleText}`;
const rootH1 = rootHtml.match(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/);
const collectionPage = findJsonLdType(
  jsonLdDocuments(rootHtml, 'Map root'),
  'CollectionPage',
);

assert.equal(rootCanonical, expectedEntries[0].url);
assert.equal(
  (rootHtml.match(/<h1\b/g) ?? []).length,
  1,
  'Map root needs one h1',
);
assert.ok(rootH1, 'Map root needs an h1');
assert.doesNotMatch(rootH1[1], /sr-only/);
assert.match(visibleText(rootH1[2]), /LZ Paper Map/i);
assert.match(rootSearchText, /\bLZ\b/i);
assert.match(rootSearchText, /LUX-ZEPLIN/i);
assert.match(rootSearchText, /\bpapers?\b/i);
assert.match(rootSearchText, /\bmap\b/i);
assert.match(rootSearchText, /\bsummar(?:y|ies)\b/i);
assert.ok(
  rootDescription.length <= 160,
  'Map description should fit a search snippet',
);
assert.equal(
  metaContent(rootHtml, 'property', 'og:url', 'Map root'),
  rootCanonical,
);
assert.match(
  metaContent(rootHtml, 'name', 'googlebot', 'Map root'),
  /max-image-preview:large/,
);
assert.ok(collectionPage, 'Map root needs CollectionPage JSON-LD');
assert.equal(collectionPage.url, rootCanonical);
assert.equal(collectionPage.dateModified, catalog.updatedAt);
assert.equal(collectionPage.inLanguage, 'en');
assert.equal(collectionPage.creator?.name, 'David Cyncynates');
assert.match(JSON.stringify(collectionPage.about), /LUX-ZEPLIN/);
assert.equal(collectionPage.mainEntity?.['@type'], 'ItemList');
assert.equal(collectionPage.mainEntity?.numberOfItems, catalog.papers.length);
assert.deepEqual(
  collectionPage.mainEntity?.itemListElement.map((item) => item.url),
  expectedEntries.slice(1).map((entry) => entry.url),
);
assert.doesNotMatch(rootHtml, /noindex/i);

const titles = new Set();
for (const paper of catalog.papers) {
  assert.ok(
    rootHtml.includes(`href="papers/${paper.id}/"`),
    `Map root must link to ${paper.id}`,
  );
  const html = readOutput('papers', paper.id, 'index.html');
  const expectedUrl = expectedEntries.find((entry) =>
    entry.url.endsWith(`/papers/${paper.id}/`),
  )?.url;
  assert.ok(expectedUrl, `Missing expected URL for ${paper.id}`);
  assert.equal(canonicalFrom(html, paper.id), expectedUrl);
  assert.equal(
    (html.match(/<h1\b/g) ?? []).length,
    1,
    `${paper.id} needs one h1`,
  );
  assert.match(html, /href="\.\.\/\.\.\/\?paper=/);
  for (const citedPaper of catalog.papers.filter((candidate) =>
    paper.cites.includes(candidate.id),
  )) {
    assert.ok(
      html.includes(
        `href="${
          expectedEntries.find((entry) =>
            entry.url.endsWith(`/papers/${citedPaper.id}/`),
          )?.url
        }"`,
      ),
      `${paper.id} must link to cited paper ${citedPaper.id}`,
    );
  }
  assert.doesNotMatch(html, /noindex/i);
  const title = titleFrom(html, paper.id);
  const description = metaContent(html, 'name', 'description', paper.id);
  const canonical = canonicalFrom(html, paper.id);
  const ogUrl = metaContent(html, 'property', 'og:url', paper.id);
  const ogImage = metaContent(html, 'property', 'og:image', paper.id);
  const jsonLd = jsonLdDocuments(html, paper.id);
  const webPage = findJsonLdType(jsonLd, 'WebPage');
  const scholarlyArticle = findJsonLdType(jsonLd, 'ScholarlyArticle');
  const breadcrumb = findJsonLdType(jsonLd, 'BreadcrumbList');
  const citedPapers = paper.cites.flatMap((citedId) => {
    const citedPaper = catalog.papers.find(
      (candidate) => candidate.id === citedId,
    );
    return citedPaper ? [citedPaper] : [];
  });

  assert.ok(!titles.has(title), `Duplicate paper title: ${title}`);
  titles.add(title);
  assert.ok(description.length > 0, `${paper.id} needs a description`);
  assert.ok(description.length <= 160, `${paper.id} description is too long`);
  assert.equal(ogUrl, canonical);
  assert.match(ogImage, /^https:\/\//);
  assert.ok(webPage, `${paper.id} needs WebPage JSON-LD`);
  assert.ok(scholarlyArticle, `${paper.id} needs ScholarlyArticle JSON-LD`);
  assert.ok(breadcrumb, `${paper.id} needs BreadcrumbList JSON-LD`);
  assert.equal(webPage['@id'], canonical);
  assert.equal(webPage.url, canonical);
  assert.equal(webPage.dateModified, undefined);
  assert.equal(webPage.inLanguage, 'en');
  assert.equal(scholarlyArticle.headline, paper.title);
  assert.equal(scholarlyArticle.identifier, `arXiv:${paper.arxivId}`);
  assert.equal(scholarlyArticle['@id'], paper.url);
  assert.equal(scholarlyArticle.url, paper.url);
  assert.equal(scholarlyArticle.sameAs, paper.url);
  assert.equal(scholarlyArticle.mainEntityOfPage, canonical);
  assert.equal(scholarlyArticle.datePublished, paper.published);
  assert.equal(scholarlyArticle.dateModified, paper.updated);
  assert.deepEqual(
    scholarlyArticle.author.map((author) => author.name),
    paper.authors,
  );
  assert.deepEqual(
    scholarlyArticle.citation,
    citedPapers.map((citedPaper) => citedPaper.url),
  );
  assert.deepEqual(
    breadcrumb.itemListElement.map(({ position, name, item }) => ({
      position,
      name,
      item,
    })),
    [
      { position: 1, name: 'LZ Paper Map', item: rootCanonical },
      { position: 2, name: paper.title, item: canonical },
    ],
  );
}

const sitemap = readOutput('sitemap.xml');
const sitemapRecords = [
  ...sitemap.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g),
].map((match) => {
  const url = match[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
  const lastModified = match[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
  assert.ok(url, 'Every sitemap record needs a URL');
  return lastModified
    ? { url: decodeEntities(url), lastModified: decodeEntities(lastModified) }
    : { url: decodeEntities(url) };
});
const sitemapUrls = sitemapRecords.map((entry) => entry.url);
assert.deepEqual(
  new Set(sitemapUrls),
  new Set(expectedEntries.map((entry) => entry.url)),
);
assert.equal(sitemapUrls.length, catalog.papers.length + 1);
assert.deepEqual(sitemapRecords, expectedEntries);
assert.ok(sitemapUrls.every((url) => url.startsWith(expectedEntries[0].url)));
assert.ok(sitemapUrls.every((url) => url.endsWith('/')));
assert.ok(sitemapUrls.every((url) => !/[?#]/.test(url)));
assert.ok(
  sitemapUrls.every((url) => !url.includes('/lz-paper-map/lz-paper-map/')),
);

console.log(
  `Validated ${catalog.papers.length} paper pages and sitemap entries.`,
);
