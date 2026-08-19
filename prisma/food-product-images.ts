/** Category-colored SVG thumbs for restaurant / café seed & QA */

const PALETTE: Record<string, { bg: string; fg: string; accent: string }> = {
  Starters: { bg: '#fef3c7', fg: '#92400e', accent: '#f59e0b' },
  Mains: { bg: '#fee2e2', fg: '#991b1b', accent: '#ef4444' },
  Beverages: { bg: '#dbeafe', fg: '#1e40af', accent: '#3b82f6' },
  Desserts: { bg: '#fce7f3', fg: '#9d174d', accent: '#ec4899' },
  default: { bg: '#e8eefb', fg: '#1e3a8a', accent: '#1a56db' },
};

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'FD';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

/** SVG data URL for menu item thumbnails (works in browser + saveProductImage). */
export function foodProductImageDataUrl(category: string, name: string): string {
  const colors = PALETTE[category] ?? PALETTE.default!;
  const label = escapeXml(name.length > 20 ? `${name.slice(0, 18)}…` : name);
  const mark = escapeXml(initials(name));
  const cat = escapeXml(category);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${colors.bg}"/>
  <circle cx="160" cy="92" r="52" fill="${colors.accent}" opacity="0.22"/>
  <circle cx="160" cy="92" r="30" fill="${colors.accent}"/>
  <text x="160" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="#ffffff">${mark}</text>
  <text x="160" y="178" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="${colors.fg}">${label}</text>
  <text x="160" y="202" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${colors.accent}">${cat}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
