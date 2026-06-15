/**
 * Entry point: load config, build the signer, start the HTTP server.
 * Run with `npm start` (SIGNER_MODE defaults to dry_run).
 */

import { loadConfig } from './config.ts';
import { createSigner } from './signer.ts';
import { startServer } from './server.ts';

const config = loadConfig(process.env);
const signer = createSigner({ mode: config.mode, apiKey: config.apiKey, signingSecret: config.signingSecret });
startServer(signer, config.port);
