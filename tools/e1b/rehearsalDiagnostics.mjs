// The code must originate here. A driver's error.code or error.name may
// contain SQL, private identifiers or other untrusted text.
const issued = new WeakMap();
export function fail(code) {
  const error = Object.assign(new Error(code), {code});
  if (typeof code === 'string' && /^[A-Z0-9_]{3,64}$/.test(code)) issued.set(error, code);
  throw error;
}

export function failureFields(error) {
  const classes = [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError];
  const builtin = classes.find(type => error instanceof type);
  return {code: issued.get(error) ?? 'UNCLASSIFIED', error_class: builtin?.name ?? (error instanceof Error ? 'Error' : 'Unknown')};
}
