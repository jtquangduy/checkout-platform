import type { TenantId, UserId } from '@platform/contracts';
import type { Role } from './roles.js';

export interface User {
  id: UserId;
  tenantId: TenantId;
  email: string;
  name: string;
  passwordHash: string;
  roles: Role[];
  status: 'ACTIVE' | 'DISABLED';
  createdAt: Date;
  updatedAt: Date;
}
