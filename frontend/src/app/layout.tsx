import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Announcer } from '@/components/a11y/Announcer';
import { Ambient } from '@/components/Ambient';
import { MockBootstrap } from './MockBootstrap';
import { Providers } from './providers';
import './globals.css';

const figtree = localFont({
  src: '../styles/fonts/Figtree-Variable.ttf',
  weight: '300 900',
  variable: '--font-figtree',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FileGrid',
  description: 'Fișierele de teren ale rețelei: încărcate sigur, verificate și ușor de găsit.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ro" className={figtree.variable}>
      <body>
        <Ambient />
        <MockBootstrap>
          <Providers>{children}</Providers>
        </MockBootstrap>
        <Announcer />
      </body>
    </html>
  );
}
