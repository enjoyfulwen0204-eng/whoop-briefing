/** Explicit, separately selectable production-beta composition. The normal
 * production entry points keep using runBriefing with no Stage 6 injection. */
import { publicBetaConfiguration } from './publicBetaConfig.js';

export async function runPublicBetaBriefing(options = {}) {
  if (publicBetaConfiguration(options.environment ?? process.env).runtime !== 'on') throw new Error('PUBLIC_BETA_RUNTIME_OFF');
  const { runExecutionPhase } = await import('./phase4Execution.js');
  return runExecutionPhase(options);
}

if (import.meta.url === `file://${process.argv[1]}`) await import('../scripts/phase4-run.js');
