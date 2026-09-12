import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_SITE_URL,
  sitemapEntries,
} from './search-discovery.mjs';

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

const rootHtml = readOutput('index.html');
assert.equal(canonicalFrom(rootHtml, 'Map root'), expectedEntries[0].url);
assert.equal((rootHtml.match(/<h1\b/g) ?? []).length, 1, 'Map root needs one h1');
assert.match(rootHtml, /"@type":"CollectionPage"/);
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
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${paper.id} needs one h1`);
  assert.match(html, /"@type":"ScholarlyArticle"/);
  assert.match(html, /href="\.\.\/\.\.\/\?paper=/);
  for (const citedPaper of catalog.papers.filter((candidate) =>
    paper.cites.includes(candidate.id),
  )) {
    assert.ok(
      html.includes(`href="${expectedEntries.find((entry) =>
        entry.url.endsWith(`/papers/${citedPaper.id}/`),
      )?.url}"`),
      `${paper.id} must link to cited paper ${citedPaper.id}`,
    );
  }
  assert.doesNotMatch(html, /noindex/i);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.ok(title, `${paper.id} needs a title`);
  assert.ok(!titles.has(title), `Duplicate paper title: ${title}`);
  titles.add(title);
}

const sitemap = readOutput('sitemap.xml');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (match) => match[1].replace(/&amp;/g, '&'),
);
assert.deepEqual(
  new Set(sitemapUrls),
  new Set(expectedEntries.map((entry) => entry.url)),
);
assert.equal(sitemapUrls.length, catalog.papers.length + 1);
assert.ok(sitemapUrls.every((url) => url.startsWith(DEFAULT_SITE_URL)));
assert.ok(sitemapUrls.every((url) => url.endsWith('/')));
assert.ok(sitemapUrls.every((url) => !/[?#]/.test(url)));
assert.ok(sitemapUrls.every((url) => !url.includes('/lz-paper-map/lz-paper-map/')));

console.log(`Validated ${catalog.papers.length} paper pages and sitemap entries.`);
