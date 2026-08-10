import { newId, TenantId } from '@platform/contracts';
import { loadIdentityConfig } from '../config.js';
import { compose } from '../composition-root.js';

const cfg = loadIdentityConfig();
const { registerUser, shutdown } = await compose(cfg);

const tenantId = TenantId.parse(newId('ten'));
const user = await registerUser.execute({
  tenantId,
  email: 'sofia@nikestudio.example',
  name: 'Sofia Marin',
  password: 'correct horse battery staple',
  roles: ['ART_DIRECTOR'],
});

console.log('Seeded tenant:', tenantId);
console.log('Seeded user:', user.email, user.id);
await shutdown();
