const DEFAULT_SITE_URL = 'https://davidcyncynates.github.io/lz-paper-map/';

function normalizeSiteUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export const SITE_URL = normalizeSiteUrl(
  process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL,
);

export function absoluteSiteUrl(path = '') {
  return new URL(path.replace(/^\/+/, ''), SITE_URL).toString();
}

export function paperDetailUrl(paperId: string) {
  return absoluteSiteUrl(`papers/${encodeURIComponent(paperId)}/`);
}
