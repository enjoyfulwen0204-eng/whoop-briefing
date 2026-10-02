/** Merge catalog modules without allowing object-spread order to decide user copy. */
export function mergeCatalogs(parts, locales = ['zh-TW', 'en', 'vi']) {
  const result = {};
  for (const [name, catalog] of parts) {
    for (const locale of Object.keys(catalog ?? {})) {
      if (!locales.includes(locale))
        throw new Error(`LOCALIZATION_LOCALE_UNSUPPORTED:${name}:${locale}`);
    }
  }
  for (const locale of locales) {
    const entries = Object.create(null);
    const owners = new Map();
    for (const [name, catalog] of parts) {
      const definitions = catalog?.[locale];
      if (!definitions || typeof definitions !== 'object')
        throw new Error(`LOCALIZATION_CATALOG_LOCALE_MISSING:${name}:${locale}`);
      for (const [key, value] of Object.entries(definitions)) {
        if (typeof value !== 'string')
          throw new Error(`LOCALIZATION_DEFINITION_INVALID:${name}:${locale}:${key}`);
        if (owners.has(key))
          throw new Error(`LOCALIZATION_DUPLICATE_KEY:${locale}:${key}:${owners.get(key)}:${name}`);
        entries[key] = value;
        owners.set(key, name);
      }
    }
    result[locale] = Object.freeze(entries);
  }
  return Object.freeze(result);
}
