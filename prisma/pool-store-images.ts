/** Category-colored SVG thumbs for pool retail seed / repair */

const PALETTE: Record<string, { bg: string; fg: string; accent: string }> = {
  'Chlorine & Shock': { bg: '#bfdbfe', fg: '#1e3a8a', accent: '#2563eb' },
  'Algaecides & Stain': { bg: '#a5f3fc', fg: '#155e75', accent: '#0891b2' },
  'Balance & Clarifiers': { bg: '#c7d2fe', fg: '#312e81', accent: '#4f46e5' },
  'Spa Chemicals': { bg: '#e9d5ff', fg: '#581c87', accent: '#7c3aed' },
  'Cleaners & Brushes': { bg: '#a7f3d0', fg: '#065f46', accent: '#059669' },
  'Filters & Pumps': { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
  'Heaters & Salt': { bg: '#fecaca', fg: '#991b1b', accent: '#dc2626' },
  'Lights & Parts': { bg: '#fde68a', fg: '#92400e', accent: '#d97706' },
  'Covers & Decks': { bg: '#d1fae5', fg: '#065f46', accent: '#10b981' },
  'Toys & Floats': { bg: '#fbcfe8', fg: '#9d174d', accent: '#db2777' },
  'Grills & Outdoor': { bg: '#fed7aa', fg: '#9a3412', accent: '#ea580c' },
  'Spas & Furniture': { bg: '#ddd6fe', fg: '#5b21b6', accent: '#7c3aed' },
  // legacy seed names
  'Pool Chemicals': { bg: '#bfdbfe', fg: '#1e3a8a', accent: '#2563eb' },
  'Spa Products': { bg: '#e9d5ff', fg: '#581c87', accent: '#7c3aed' },
  Equipment: { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
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
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

/** Reliable base64 SVG for <img src> */
export function poolProductImageDataUrl(
  category: string,
  name: string,
): string {
  const colors = PALETTE[category] ?? PALETTE.Equipment!;
  const label = escapeXml(name.length > 18 ? `${name.slice(0, 16)}…` : name);
  const mark = escapeXml(initials(name));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${colors.bg}"/>
  <circle cx="160" cy="95" r="48" fill="${colors.accent}" opacity="0.25"/>
  <circle cx="160" cy="95" r="28" fill="${colors.accent}"/>
  <text x="160" y="103" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${mark}</text>
  <text x="160" y="185" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="${colors.fg}">${label}</text>
  <text x="160" y="208" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${colors.accent}">${escapeXml(category)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
