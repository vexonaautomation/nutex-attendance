import { NextResponse, type NextRequest } from 'next/server';

// The browser only ever talks to its own origin (cookies stay first-party, the API URL stays private).
// This runs per request, so API_URL is read when the server runs, not when the site was built.
export function proxy(req: NextRequest) {
  const api = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
  return NextResponse.rewrite(new URL(`${api}${req.nextUrl.pathname}${req.nextUrl.search}`));
}

export const config = { matcher: '/api/:path*' };
