import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { log, describeError } from './logger.js';

// GitHub's worst observed gap was 273 minutes. Twelve hours is >2.6x that evidence and
// deliberately treats the best-effort backup as degraded without paging the product user.
export const SCHEDULER_POLICY = Object.freeze({
  cloudflare: Object.freeze({
    role: 'primary', component: HEARTBEAT_COMPONENT.CLOUDFLARE,
    healthyAgeMs: 30 * 60_000, degradedAgeMs: 30 * 60_000,
    alertableAgeMs: 30 * 60_000, notify: true,
  }),
  github: Object.freeze({
    role: 'backup', component: HEARTBEAT_COMPONENT.GITHUB,
    healthyAgeMs: 6 * 60 * 60_000, degradedAgeMs: 6 * 60 * 60_000,
    alertableAgeMs: 12 * 60 * 60_000, notify: false,
  }),
});

/**
 * 持續性故障的通知冷卻。
 *
 * 全域預設的 2 小時是給「一次性錯誤」用的。排程器離線是**持續狀態**：
 * 備援每小時跑一次，2 小時冷卻等於一天 12 則、兩天 24 則一模一樣的警報。
 * 實測過那個數字（48 小時 24 則），那不是通知而是噪音。
 *
 * 所以：第一次確認離線時通知一次，之後最多每 24 小時再提醒一次。
 */
export const SCHEDULER_ALERT_COOLDOWN_HOURS = 24;

/** 故障通知的訊號名稱（error_notifications 的 key，同時也是「已宣告故障」的旗標）。 */
export const SCHEDULER_ALERT_TYPE = 'scheduler_primary_stale';

export function providerState(heartbeat, provider, now = new Date()) {
  const policy = SCHEDULER_POLICY[provider];
  if (!heartbeat?.lastOkAt) return { provider, state: 'uninitialized', ageMs: null };
  const ageMs = now.getTime() - Date.parse(heartbeat.lastOkAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { provider, state: 'unknown', ageMs: null };
  if (ageMs <= policy.healthyAgeMs) return { provider, state: 'healthy', ageMs };
  if (ageMs <= policy.alertableAgeMs) return { provider, state: 'delayed', ageMs };
  return { provider, state: 'stale', ageMs };
}

export function aggregateSchedulerState(cloudflare, github) {
  if (cloudflare.state === 'healthy') return 'healthy';
  if (github.state === 'healthy' || github.state === 'delayed') return 'degraded';
  if (cloudflare.state === 'stale' && github.state === 'stale') return 'outage';
  if (cloudflare.state === 'uninitialized' && github.state === 'uninitialized') return 'uninitialized';
  return 'unknown';
}

export async function readSchedulerHealth({ db, now = new Date() }) {
  const [cf, gh] = await Promise.all([
    db.getHeartbeat(GLOBAL_SCOPE, SCHEDULER_POLICY.cloudflare.component),
    db.getHeartbeat(GLOBAL_SCOPE, SCHEDULER_POLICY.github.component),
  ]);
  const cloudflare = providerState(cf, 'cloudflare', now);
  const github = providerState(gh, 'github', now);
  return { cloudflare, github, overall: aggregateSchedulerState(cloudflare, github) };
}

/**
 * 對等監看：跑完的那一邊去看另一邊還活著嗎。
 *
 * ## 通知政策（實測數字驅動）
 *
 *   · 只有**備援跑到、而且主要排程確認離線**時才通知使用者。
 *     主要排程每 10 分鐘跑一次，如果由它來抱怨備援，光是備援正常的延遲
 *     就會製造整天的假警報。
 *   · 第一次確認離線 → 一則通知。之後同一場故障最多每 24 小時再一則。
 *   · 主要排程恢復 → **只有在真的宣告過故障時**才送一則恢復通知，然後把
 *     旗標清掉。沒宣告過就沒有恢復可言，送了只會讓人困惑。
 *   · 備援自己延遲 → 只進結構化日誌，不吵使用者。
 *   · 兩邊都離線 → 仍然只有一則（同一個訊號、同一個冷卻），不會變成兩場
 *     互相競爭的警報風暴。
 */
export async function checkPeerScheduler({ db, source, systemTelegram, now = new Date() }) {
  try {
    const health = await readSchedulerHealth({ db, now });
    const peer = source === 'cloudflare' ? health.github : health.cloudflare;
    const primary = health.cloudflare;
    log.info('scheduler_watchdog_state', {
      source, peer: peer.provider, peer_state: peer.state, overall: health.overall,
      peer_age_ms: peer.ageMs, primary_state: primary.state,
    });

    let alerted = false;
    let recovered = false;

    // ---- 主要排程確認離線 ----
    // 只有備援在跑時才有資格說這句話（主要排程自己顯然跑不動）。
    if (source === 'github' && primary.state === 'stale') {
      alerted = await systemTelegram.notifyError(
        SCHEDULER_ALERT_TYPE,
        'The frequent briefing scheduler has no recent successful completion; '
        + 'the lower-frequency fallback is still running and briefings continue.',
        { cooldownHours: SCHEDULER_ALERT_COOLDOWN_HOURS },
      );
    }

    // ---- 主要排程恢復 ----
    // 由**主要排程自己**跑完時判定：它能寫 heartbeat 就代表它活著。
    if (source === 'cloudflare' && primary.state === 'healthy'
      && typeof db.hasErrorNotify === 'function') {
      const announced = await db.hasErrorNotify(GLOBAL_SCOPE, SCHEDULER_ALERT_TYPE);
      if (announced) {
        // 先清旗標再送：就算送失敗，也不會每 10 分鐘重試一次恢復通知。
        await db.clearErrorNotify(GLOBAL_SCOPE, SCHEDULER_ALERT_TYPE);
        recovered = true;
        try {
          await systemTelegram.send('✅ 簡報排程已恢復正常，後續會照常檢查。');
        } catch (err) {
          log.warn('scheduler_recovery_notify_failed', { error: describeError(err) });
        }
      }
    }

    return { ...health, peer: peer.provider, alerted, recovered };
  } catch (err) {
    log.warn('scheduler_watchdog_failed', { source, error: describeError(err) });
    return {
      overall: 'unknown', peer: source === 'cloudflare' ? 'github' : 'cloudflare',
      alerted: false, recovered: false,
    };
  }
}
