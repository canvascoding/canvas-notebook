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

  // Experimental features
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // Für File Uploads
    },
  },
};

export default nextConfig;
