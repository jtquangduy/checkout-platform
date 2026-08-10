export const ROLES = ['ART_DIRECTOR', 'PRODUCER', 'FINANCE', 'TENANT_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
