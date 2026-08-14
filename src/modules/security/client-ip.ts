import type { FastifyRequest } from 'fastify';

export function clientIpFromRequest(req: FastifyRequest | { ip?: string; headers?: Record<string, unknown> }): string {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const fwd = headers['x-forwarded-for'];
  const raw =
    typeof fwd === 'string'
      ? fwd.split(',')[0]?.trim()
      : Array.isArray(fwd)
        ? String(fwd[0] ?? '').trim()
        : '';
  const ip = raw || (typeof req.ip === 'string' ? req.ip : '') || '';
  return normalizeIp(ip);
}

export function normalizeIp(ip: string) {
  const v = ip.trim().toLowerCase();
  if (v.startsWith('::ffff:')) return v.slice(7);
  if (v === '::1') return '127.0.0.1';
  return v;
}

/** Exact IP, trailing-dot prefix (192.168.1.), or CIDR like 10.0.0.0/8 */
export function ipMatchesAllowlist(ip: string, allowlist: string[]): boolean {
  const list = allowlist.map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const n = normalizeIp(ip);
  if (!n) return false;
  return list.some((rule) => matchOne(n, rule.toLowerCase()));
}

function matchOne(ip: string, rule: string): boolean {
  if (rule.endsWith('.')) return ip.startsWith(rule);
  if (rule.includes('/')) return cidrMatch(ip, rule);
  return ip === normalizeIp(rule);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base ?? '');
  if (ipN == null || baseN == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}
