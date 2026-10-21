import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DialogDocumentsProvider from './dialog-documents-provider';
import './globals.css';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') ?? '';
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://binary-mask-studio.muzhe-su.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Binary Mask Studio',
  description: 'Precisely create, edit, and export binary images and matrices containing only 0 and 1.',
  icons: {
    icon: [{ url: `${basePath}/icon.svg`, type: 'image/svg+xml' }],
  },
  openGraph: {
    title: 'Binary Mask Studio',
    description: 'Precisely create and export binary images with 0 and 1',
    type: 'website',
    locale: 'en_US',
    images: [{ url: `${basePath}/og.png`, alt: 'Binary Mask Studio interface preview' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Binary Mask Studio',
    description: 'Precisely create and export binary images with 0 and 1',
    images: [`${basePath}/og.png`],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Static export includes the TXT content in the initial page payload.
  const documents = {
    help: readFileSync(join(process.cwd(), 'public', 'help.txt'), 'utf8'),
    about: readFileSync(join(process.cwd(), 'public', 'about.txt'), 'utf8'),
  };
  return (
    <html lang="en">
      <body><DialogDocumentsProvider documents={documents}>{children}</DialogDocumentsProvider></body>
    </html>
  );
}
