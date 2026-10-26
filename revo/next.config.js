const fs = require('fs');
const path = require('path');

// Clean stale .next/cache if present so webpack rebuilds cleanly without stale cached chunks
const cacheDir = path.resolve(__dirname, '.next', 'cache');
if (fs.existsSync(cacheDir)) {
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch (err) {
    // ignore
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config) => {
    const projectRoot = path.resolve(__dirname);

    // Restrict module and loader resolution strictly to local node_modules.
    // Prevents enhanced-resolve from traversing up parent paths to /data/node_modules.
    config.resolve.modules = [
      path.resolve(projectRoot, 'node_modules'),
    ];
    if (config.resolveLoader) {
      config.resolveLoader.modules = [
        path.resolve(projectRoot, 'node_modules'),
      ];
    }

    // Filter out restricted Android/Termux ancestor paths (/data, /data/data)
    // from Webpack's dependency sets so Watchpack never tries to scan or watch them.
    config.plugins = config.plugins || [];
    config.plugins.push({
      apply(compiler) {
        compiler.hooks.afterCompile.tap('FilterTermuxRestrictedWatchPaths', (compilation) => {
          const filterSet = (set) => {
            if (!set) return;
            for (const item of Array.from(set)) {
              if (typeof item === 'string' && !item.startsWith(projectRoot)) {
                set.delete(item);
              }
            }
          };
          filterSet(compilation.missingDependencies);
          filterSet(compilation.contextDependencies);
          filterSet(compilation.fileDependencies);
        });
      },
    });

    config.watchOptions = {
      aggregateTimeout: 300,
      poll: 1000,
      followSymlinks: false,
      ignored: [
        '**/node_modules/**',
        '**/.next/**',
        '**/.git/**',
      ],
    };

    return config;
  },
};

module.exports = nextConfig;
