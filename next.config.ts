import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
};

export default config;
