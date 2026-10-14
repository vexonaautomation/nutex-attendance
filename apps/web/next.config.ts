import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const isProd = process.env.NODE_ENV === 'production';

// Check-in / check-out read the device location, so this page origin may use geolocation; the camera and microphone are never needed.
// The Permissions-Policy belongs to the document that was loaded, and the app switches pages without a reload, so it is the same on every route.
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(self)';

const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Next needs inline bootstrap scripts; dev also needs eval for HMR
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "connect-src 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@nutex/types', '@nutex/report-engine'],
  async rewrites() {
    // the browser only ever talks to its own origin: cookies stay first-party and the API URL stays private
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Permissions-Policy', value: PERMISSIONS },
        ],
      },
    ];
  },
};

export default nextConfig;
