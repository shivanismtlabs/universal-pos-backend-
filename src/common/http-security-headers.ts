type HeaderWriter = {
  header(name: string, value: string): unknown;
};

/**
 * JSON API headers. CSP is document-restrictive; skip /docs (Swagger UI).
 */
export function applyApiSecurityHeaders(
  reply: HeaderWriter,
  url?: string,
): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-XSS-Protection', '0');
  const path = url ?? '';
  if (!path.startsWith('/docs')) {
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
}
