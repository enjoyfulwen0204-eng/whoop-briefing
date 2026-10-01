/** Explicit, separately selectable production-beta composition. The normal
 * production entry points keep using runBriefing with no Stage 6 injection. */
import { loadDotEnvIfPresent, loadEnv } from './config.js';
import { createDb } from './db.js';
import { runBriefing } from './index.js';
import { publicBetaConfiguration, publicBetaKeys } from './publicBetaConfig.js';
import { authorizePublicBetaRuntime, createPublicBetaRuntime } from './publicBeta.js';

export async function runPublicBetaBriefing({ now = new Date(), triggerSource = 'manual',
  environment = process.env } = {}) {
  const config = publicBetaConfiguration(environment);
  if (config.runtime !== 'on') throw new Error('PUBLIC_BETA_RUNTIME_OFF');
  const keys = publicBetaKeys(environment);
  const env = loadEnv();
  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken, phase4Keys: keys });
  try {
    await db.migrate();
    const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
    const runtime = await createPublicBetaRuntime({ db, keys, executionMode: 'SHADOW',
      runtimeCapability: capability, presentationPolicy: config.policy });
    return await runBriefing({ now, triggerSource, deps: { db, env, ...runtime } });
  } finally {
    try { db.close(); } catch { /* runner may already have closed it */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnvIfPresent();
  runPublicBetaBriefing({ triggerSource: process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_EVENT_NAME === 'schedule' ? 'github' : 'manual' })
    .then(result => { process.exitCode = result.errors.length || result.failed ? 1 : 0; })
    .catch(error => { console.error(error?.code ?? error?.message ?? 'PUBLIC_BETA_FAILED'); process.exitCode = 1; });
}
