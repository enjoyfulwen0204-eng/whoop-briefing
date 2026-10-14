const readers=new WeakSet();
// Trusted server routing brands a pure command callback. This grants no
// tenant/write authority; the DB still forbids mutations and fences its result.
export function readOnlyTelegramOperation(fn){const callback=()=>fn();readers.add(callback);return callback;}
export const isReadOnlyTelegramOperation=fn=>readers.has(fn);
