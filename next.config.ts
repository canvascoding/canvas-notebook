import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wichtig für native Server-Pakete: Als external markieren im Server Bundle
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('node-pty', 'better-sqlite3', 'better-auth', 'drizzle-orm');
    }
    return config;
  },
  serverExternalPackages: ['node-pty', 'better-sqlite3', 'better-auth', 'drizzle-orm'],
  poweredByHeader: false,
  compress: true,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
          },
        ],
      },
    ];
  },

  // Experimental features
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // Für File Uploads
    },
    // Required when proxy/middleware is enabled; otherwise multipart uploads are truncated at 10MB.
    proxyClientMaxBodySize: '256mb',
  },
};

export default nextConfig;
