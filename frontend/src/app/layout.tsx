import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Announcer } from '@/components/a11y/Announcer';
import { MockBootstrap } from './MockBootstrap';
import './globals.css';

const figtree = localFont({
  src: '../styles/fonts/Figtree-Variable.ttf',
  weight: '300 900',
  variable: '--font-figtree',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FileGrid',
  description: 'Prototip FileGrid · Hackathon PPC',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ro" className={figtree.variable}>
      <body>
        <MockBootstrap>{children}</MockBootstrap>
        <Announcer />
      </body>
    </html>
  );
}
