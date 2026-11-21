// Loaded before the app with `node --import @lab/telemetry/register src/<entry>.ts`.
// The ESM hook lets instrumentations patch modules the app loads with `import` (pg, ioredis, http).
import { register } from 'node:module';
import { startTelemetry } from './sdk.ts';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
startTelemetry();
