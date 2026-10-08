import type { Metadata } from 'next';
import { createColorThemeBootstrapScript } from '@/lib/color-theme';
import { absoluteSiteUrl, SITE_URL } from '@/lib/site-url';
import './globals.css';

const socialImage = absoluteSiteUrl('og.png');
const siteTitle = 'LZ Paper Map: 248 keV Papers & Summaries | LUX-ZEPLIN';
const siteDescription =
  'A searchable map of LZ papers about the 248 keV LUX-ZEPLIN high-recoil candidate, with concise summaries, physics categories and citation lineage.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: siteTitle,
  description: siteDescription,
  applicationName: 'LZ Paper Map',
  creator: 'David Cyncynates',
  publisher: 'David Cyncynates',
  alternates: { canonical: SITE_URL },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    siteName: 'LZ Paper Map',
    locale: 'en_US',
    type: 'website',
    url: SITE_URL,
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
    title: siteTitle,
    description: siteDescription,
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta id="theme-color" name="theme-color" content="#f4f1e9" />
        <script
          dangerouslySetInnerHTML={{
            __html: createColorThemeBootstrapScript(),
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
