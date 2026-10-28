import type { RequestHandler } from 'express';

// A JSON-only API: nothing may be cached, sniffed, framed, or embedded. HSTS is left to the TLS terminator.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
};
