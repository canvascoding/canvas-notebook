import localFont from 'next/font/local';

export const geistSans = localFont({
  src: [
    {
      path: '../../seed_skills/canvas-design/canvas-fonts/InstrumentSans-Regular.ttf',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../seed_skills/canvas-design/canvas-fonts/InstrumentSans-Bold.ttf',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-geist-sans',
  display: 'swap',
});

export const geistMono = localFont({
  src: [
    {
      path: '../../seed_skills/canvas-design/canvas-fonts/GeistMono-Regular.ttf',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../seed_skills/canvas-design/canvas-fonts/GeistMono-Bold.ttf',
      weight: '700',
      style: 'normal',
    },
  ],
  variable: '--font-geist-mono',
  display: 'swap',
});
