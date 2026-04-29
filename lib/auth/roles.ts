export type Role = 'admin' | 'tier1' | 'tier2' | 'pending';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '관리자',
  tier1: '1차 접근',
  tier2: '2차 접근',
  pending: '승인 대기',
};

export const ROLE_ORDER: Record<Role, number> = {
  admin: 4,
  tier1: 3,
  tier2: 2,
  pending: 1,
};

export function canChat(role: Role): boolean {
  return role === 'admin' || role === 'tier1' || role === 'tier2';
}

export function canUpload(role: Role): boolean {
  return role === 'admin' || role === 'tier1';
}

export function canAccessAdmin(role: Role): boolean {
  return role === 'admin';
}

export function canAccessSensitive(role: Role): boolean {
  return role === 'admin' || role === 'tier1';
}
