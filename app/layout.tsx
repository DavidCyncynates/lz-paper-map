import type { Metadata } from 'next';
import { createColorThemeBootstrapScript } from '@/lib/color-theme';
import { absoluteSiteUrl, SITE_URL } from '@/lib/site-url';
import './globals.css';

const socialImage = absoluteSiteUrl('og.png');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'LUX-ZEPLIN 248 keV Paper Map — High-Recoil Literature',
  description:
    'A living research map of papers responding to the September 2026 LUX-ZEPLIN 248 keV high-energy nuclear-recoil candidate.',
  alternates: { canonical: SITE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    title: 'LUX-ZEPLIN 248 keV Paper Map',
    description:
      'A living map of the literature responding to LZ’s isolated high-recoil candidate.',
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
    title: 'LUX-ZEPLIN 248 keV Paper Map',
    description:
      'A living map of the literature responding to LZ’s isolated high-recoil candidate.',
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
