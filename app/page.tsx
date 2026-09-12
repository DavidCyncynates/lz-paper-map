import landscape from '@/data/landscape.json';
import { serializeJsonLd } from '@/lib/json-ld';
import { paperDetailUrl, SITE_URL } from '@/lib/site-url';
import { LzLandscape } from './lz-landscape';

export default function Home() {
  const collectionJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'LUX-ZEPLIN 248 keV Paper Map',
    description:
      'A living research map of papers responding to the September 2026 LUX-ZEPLIN high-energy nuclear-recoil candidate.',
    url: SITE_URL,
    isPartOf: {
      '@type': 'WebSite',
      name: 'David Cyncynates',
      url: 'https://davidcyncynates.github.io/',
    },
    about: [
      'LUX-ZEPLIN experiment',
      '248 keV nuclear-recoil candidate',
      'dark matter phenomenology',
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
