import type { NextConfig } from 'next';

const [repositoryOwner = '', repositoryName = ''] =
  process.env.GITHUB_REPOSITORY?.split('/') ?? [];
const isRootPage =
  repositoryName.toLowerCase() ===
  `${repositoryOwner.toLowerCase()}.github.io`;
const isProjectPage =
  process.env.GITHUB_ACTIONS === 'true' &&
  repositoryName.length > 0 &&
  !isRootPage;
const assetPrefix = isProjectPage ? `/${repositoryName}` : '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  assetPrefix,
  images: { unoptimized: true },
};

export default nextConfig;
