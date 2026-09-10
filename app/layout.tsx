import type { Metadata } from 'next';
import { createColorThemeBootstrapScript } from '@/lib/color-theme';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const normalizedSiteUrl = siteUrl
  ? `${siteUrl.replace(/\/+$/, '')}/`
  : undefined;
const socialImage = normalizedSiteUrl
  ? new URL('og.png', normalizedSiteUrl).toString()
  : undefined;

export const metadata: Metadata = {
  title: 'LZ Paper Map — High-recoil literature',
  description:
    'A living map of papers responding to the September 2026 LUX-ZEPLIN high-energy nuclear-recoil candidate.',
  ...(normalizedSiteUrl
    ? {
        metadataBase: new URL(normalizedSiteUrl),
        alternates: { canonical: normalizedSiteUrl },
      }
    : {}),
  openGraph: {
    title: 'LZ Paper Map',
    description: 'The September 2026 high-recoil literature landscape.',
    type: 'website',
    ...(socialImage
      ? {
          images: [
            {
              url: socialImage,
              width: 1200,
              height: 630,
              alt: 'LZ Paper Map shown as a scientific island atlas',
            },
          ],
        }
      : {}),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LZ Paper Map',
    description: 'The September 2026 high-recoil literature landscape.',
    ...(socialImage ? { images: [socialImage] } : {}),
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
