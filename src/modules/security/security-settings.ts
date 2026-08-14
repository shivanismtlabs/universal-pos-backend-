export type TenantSecuritySettings = {
  ipAllowlist: string[];
  idleTimeoutMinutes: number;
  encryptBackups: boolean;
};

export function parseSecuritySettings(raw: unknown): TenantSecuritySettings {
  const root =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const block =
    root.security && typeof root.security === 'object'
      ? (root.security as Record<string, unknown>)
      : {};
  const list = Array.isArray(block.ipAllowlist)
    ? block.ipAllowlist.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const idle = Number(block.idleTimeoutMinutes);
  return {
    ipAllowlist: list,
    idleTimeoutMinutes:
      Number.isFinite(idle) && idle >= 0 && idle <= 480 ? Math.floor(idle) : 0,
    encryptBackups: block.encryptBackups === true,
  };
}

export function mergeSecuritySettings(
  currentSettings: unknown,
  patch: Partial<TenantSecuritySettings>,
): Record<string, unknown> {
  const root =
    currentSettings && typeof currentSettings === 'object'
      ? { ...(currentSettings as Record<string, unknown>) }
      : {};
  const prev = parseSecuritySettings(root);
  root.security = {
    ipAllowlist: patch.ipAllowlist ?? prev.ipAllowlist,
    idleTimeoutMinutes:
      patch.idleTimeoutMinutes ?? prev.idleTimeoutMinutes,
    encryptBackups: patch.encryptBackups ?? prev.encryptBackups,
  };
  return root;
}
