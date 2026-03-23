import type {MetadataRoute} from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/'
      }
    ]
    // Kein sitemap-Link – App soll nicht indexiert werden
  };
}
