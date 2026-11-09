/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    lockDistDir: false,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: [
          '**/.git/**',
          '**/node_modules/**',
          '**/.data/**',
          '**/data/**',
          '**/*.enc',
          '**/*.json',
          '**/tmp/**',
        ],
      };
    }
    return config;
  },
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/emptyModule.js' },
      path: { browser: './src/lib/emptyModule.js' },
    },
  },
};

module.exports = nextConfig;
