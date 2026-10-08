import landscape from '@/data/landscape.json';
import { serializeJsonLd } from '@/lib/json-ld';
import { paperDetailUrl, SITE_URL } from '@/lib/site-url';
import { LzLandscape } from './lz-landscape';

export default function Home() {
  const collectionJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'LZ Paper Map: 248 keV Papers & Summaries',
    alternateName: 'LUX-ZEPLIN 248 keV Paper Map',
    description:
      'A searchable map of LZ papers about the 248 keV LUX-ZEPLIN high-recoil candidate, with concise summaries, physics categories and citation lineage.',
    url: SITE_URL,
    dateModified: landscape.updatedAt,
    inLanguage: 'en',
    creator: {
      '@type': 'Person',
      name: 'David Cyncynates',
      url: 'https://davidcyncynates.github.io/',
    },
    isPartOf: {
      '@type': 'WebSite',
      name: 'David Cyncynates',
      url: 'https://davidcyncynates.github.io/',
    },
    about: [
      {
        '@type': 'Thing',
        name: 'LUX-ZEPLIN experiment',
      },
      {
        '@type': 'Thing',
        name: '248 keV nuclear-recoil candidate',
      },
      {
        '@type': 'Thing',
        name: 'Dark matter phenomenology',
      },
    ],
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: landscape.papers.length,
      itemListElement: landscape.papers.map((paper, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: paper.title,
        url: paperDetailUrl(paper.id),
      })),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(collectionJsonLd),
        }}
      />
      <LzLandscape />
    </>
  );
}
