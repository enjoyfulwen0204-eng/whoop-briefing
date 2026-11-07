import {scanErasureExecutions, ownersForExecution} from '../../src/erasureExecutionScan.js';

// Use the cohort captured before erasure. Looking users up afterward loses
// the identities needed to recognize their keyed receipts.
export async function countSubjectReceipts(client, keys, subjects) {
  let count = 0;
  for await (const {execution, receipts} of scanErasureExecutions(client)) {
    count += ownersForExecution(keys, subjects, execution, receipts).size;
  }
  return count;
}

export function assertJobStartWindow(at = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
  if (time < '12:10' || time >= '23:30') {
    throw Object.assign(new Error('JOB_WINDOW_CLOSED'), {code: 'JOB_WINDOW_CLOSED'});
  }
}
