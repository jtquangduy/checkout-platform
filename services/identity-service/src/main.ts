import { loadIdentityConfig } from './config.js';
import { compose } from './composition-root.js';

const cfg = loadIdentityConfig();
const { app, shutdown } = await compose(cfg);

const server = app.listen(cfg.PORT, () => {
  console.log(`identity-service listening on ${cfg.PORT}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await shutdown();
  process.exit(0);
});
