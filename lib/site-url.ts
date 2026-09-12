const DEFAULT_SITE_URL =
  'https://davidcyncynates.github.io/lz-paper-map/';

export const SITE_URL = `${(
  process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL
).replace(/\/+$/, '')}/`;

export function absoluteSiteUrl(path = '') {
  return new URL(path.replace(/^\/+/, ''), SITE_URL).toString();
}

export function paperDetailUrl(paperId: string) {
  return absoluteSiteUrl(`papers/${encodeURIComponent(paperId)}/`);
}
