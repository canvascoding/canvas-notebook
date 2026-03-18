import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from "next";

const externalPackages = [
  'node-pty',
  'better-sqlite3',
  'drizzle-orm',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-agent-core',
];

const sentryTunnelRoute = process.env.SENTRY_TUNNEL_ROUTE?.trim() || undefined;

const nextConfig: NextConfig = {
  // Output standalone for smaller Docker image
  output: 'standalone',

  // Wichtig für native Server-Pakete: Als external markieren im Server Bundle
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push(...externalPackages);
    }
    return config;
  },
  serverExternalPackages: externalPackages,
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
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },

  async rewrites() {
    return [
      // Redirect old /media/* URLs to /api/media/* for backward compatibility
      {
        source: '/media/:path*',
        destination: '/api/media/:path*',
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

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "canvas-holdings",

  project: "canvas-notebook",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Keep the Sentry tunnel opt-in. The default container path should not route browser
  // telemetry back through Next.js because it adds avoidable startup log noise.
  ...(sentryTunnelRoute ? { tunnelRoute: sentryTunnelRoute } : {}),

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
