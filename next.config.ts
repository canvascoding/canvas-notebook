import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wichtig für node-pty: Als external markieren im Server Bundle
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('node-pty', 'ssh2', 'ssh2-sftp-client', 'better-sqlite3', 'better-auth', 'drizzle-orm');
    }
    return config;
  },
  serverExternalPackages: ['node-pty', 'ssh2', 'ssh2-sftp-client', 'better-sqlite3', 'better-auth', 'drizzle-orm'],
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
