import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Canvas Notebook',
    short_name: 'Canvas Notebook',
    description: 'Canvas Notebook — self-hosted workspace suite with file browser, terminal, and AI chat.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0f151d',
    theme_color: '#0f151d',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    shortcuts: [
      {
        name: 'Terminal',
        short_name: 'Terminal',
        description: 'Open the fullscreen terminal app.',
        url: '/terminal',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
      {
        name: 'Notebook',
        short_name: 'Notebook',
        description: 'Open Canvas Notebook.',
        url: '/notebook',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
        ],
      },
    ],
  };
}
