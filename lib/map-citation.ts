export const MAP_CITATION = {
  title: 'LZ Paper Map: literature on the 248 keV nuclear-recoil candidate',
  author: 'David Cyncynates',
  year: 2026,
  url: 'https://davidcyncynates.github.io/lz-paper-map/',
  conceptDoi: '10.5281/zenodo.23688061',
  versionDoi: '10.5281/zenodo.23688062',
};

/** Cite the evolving map; a specific archived version has its own DOI. */
export function mapBibtex() {
  return [
    '@misc{Cyncynates2026LZPaperMap,',
    '  author = {Cyncynates, David},',
    `  title = {{${MAP_CITATION.title}}},`,
    `  year = {${MAP_CITATION.year}},`,
    '  howpublished = {Interactive literature map},',
    ...(MAP_CITATION.conceptDoi
      ? [`  doi = {${MAP_CITATION.conceptDoi}},`]
      : []),
    `  url = {${MAP_CITATION.url}}`,
    '}',
  ].join('\n');
}
