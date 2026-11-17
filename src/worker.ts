import { createAvarestApiApp } from './server/app.ts';

// Cloudflare Workers entrypoint (pure Web Standards, zero Node-only APIs)
const workerApp = createAvarestApiApp();

export default workerApp;
