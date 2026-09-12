export const DEFAULT_SITE_URL =
  'https://davidcyncynates.github.io/lz-paper-map/';

export function normalizeSiteUrl(value = DEFAULT_SITE_URL) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export function sitemapEntries(catalog, siteUrl = DEFAULT_SITE_URL) {
  const root = normalizeSiteUrl(siteUrl);
  const collectionLastModified = catalog.updatedAt;
  return [
    { url: root, lastModified: collectionLastModified },
    ...catalog.papers.map((paper) => ({
      url: new URL(
        `papers/${encodeURIComponent(paper.id)}/`,
        root,
      ).toString(),
      lastModified: paper.updated,
    })),
  ];
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemap(catalog, siteUrl = DEFAULT_SITE_URL) {
  const entries = sitemapEntries(catalog, siteUrl);
  const urls = entries
    .map(
      ({ url, lastModified }) =>
        `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${escapeXml(lastModified)}</lastmod>\n  </url>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
