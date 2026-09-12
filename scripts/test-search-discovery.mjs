import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SITE_URL,
  normalizeSiteUrl,
  renderSitemap,
  sitemapEntries,
} from './search-discovery.mjs';

const catalog = JSON.parse(
  readFileSync(new URL('../data/landscape.json', import.meta.url), 'utf8'),
);

test('normalizes the public project URL with one trailing slash', () => {
  assert.equal(
    normalizeSiteUrl(`${DEFAULT_SITE_URL}///?ignored=yes#fragment`),
    DEFAULT_SITE_URL,
  );
});

test('lists the map and every catalog paper exactly once', () => {
  const entries = sitemapEntries(catalog);
  const urls = entries.map((entry) => entry.url);
  assert.equal(entries.length, catalog.papers.length + 1);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls[0], DEFAULT_SITE_URL);
  for (const paper of catalog.papers) {
    const entry = entries.find((candidate) =>
      candidate.url.endsWith(`/papers/${paper.id}/`),
    );
    assert.ok(
      entry,
      `Missing sitemap entry for ${paper.id}`,
    );
    assert.equal(entry.lastModified, paper.updated);
  }
});

test('renders absolute, escaped XML sitemap entries', () => {
  const xml = renderSitemap({
    updatedAt: '2026-09-12',
    papers: [{ id: 'paper&one', updated: '2026-09-11' }],
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /https:\/\/davidcyncynates\.github\.io\/lz-paper-map\//);
  assert.match(xml, /paper%26one/);
  assert.match(xml, /<lastmod>2026-09-11<\/lastmod>/);
  assert.doesNotMatch(xml, /localhost/);
});
