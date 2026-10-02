import { t } from './localization.js';

/** Closed public mapping. Unknown private codes never enter interpolation. */
const CODE_TO_KEY = Object.freeze({
  negative_numeric_value: 'validation.negative',
  UNKNOWN_UNIT: 'validation.unit',
  UNIT_REQUIRED: 'validation.unit',
  VALUE_REQUIRED: 'validation.required',
  CUSTOM_VALUE_REQUIRED: 'validation.required',
  unknown_category: 'validation.unsupported',
  INVALID_CATEGORY: 'validation.unsupported',
  INVALID_VALUE_KIND: 'validation.unsupported',
  UNSUPPORTED_CANDIDATE_FIELDS: 'validation.unsupported',
});

export function validationMessageKey(code) {
  const privateCode = String(code ?? '');
  return (Object.hasOwn(CODE_TO_KEY, privateCode) ? CODE_TO_KEY[privateCode] : null)
    ?? (Object.hasOwn(CODE_TO_KEY, privateCode.split(':')[0])
      ? CODE_TO_KEY[privateCode.split(':')[0]] : null)
    ?? 'validation.generic';
}

export function renderValidationFailure(locale, errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  const keys = list.map(validationMessageKey);
  const key = keys.find(value => value !== 'validation.generic') ?? 'validation.generic';
  return t(locale, key);
}
