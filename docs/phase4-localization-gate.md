# Phase 4 Localization Gate

This gate prepares Stage 1–6 presentation in Traditional Chinese (zh-TW), English (en), and Vietnamese (vi). It does not deploy or activate Public Beta. The Beta gate remains OFF; Stage 7 and Stage 8 remain unimplemented. Body Energy remains NOT_AUTHORIZED_NOT_PRESENTED.

## Storage and selection

Schema v31 is Localization. The v30 identity and notification-preference records had no durable field suitable for a canonical per-user language choice. V31 adds user_locales and user_locale_prompts with user foreign keys. The locale column permits only zh-TW, en, and vi. A missing row means UNSET; migration does not infer a language from old Chinese copy, Telegram profile metadata, timezone, country, name, or chat title. setLocale is an atomic per-user upsert, and repeated selection is idempotent.

New users see the trilingual language selector before localized timezone and WHOOP authorization instructions. Unsupported input leaves them at selection. The choice survives restart. An existing user without a locale gets one durable selection prompt before newly localized content is delivered; ordinary report and Beta Summary delivery wait for the choice. Identity, account authorization, scheduler admission, WHOOP sync and Stage 6 SHADOW computation remain governed by their existing authorities. A saved locale does not grant Beta eligibility, and Beta eligibility does not invent a locale.

Already bound users can complete the language choice even when self-service WHOOP OAuth is disabled. Locale selection is independent of authorization setup.

The onboarding mechanism accepts the three displayed text choices. It introduces no Stage 7 Quick Actions or general button framework. There is no existing post-onboarding settings interface to reuse, so this gate does not add a settings UI. Stage 7 may later expose a simpler language-change control using the same canonical store.

## Rendering authority

Production delivery entry points resolve locale from the target user's durable row. There is no process-global current locale. Catalog keys, named interpolation, and local date/number formatting live in the localization module and its catalogs. Import-time catalog validation requires identical keys and placeholder names in all three catalogs; missing translations fail closed rather than falling through to another language. Unexpected runtime failures may return only a generic localized temporary-error message. User-derived interpolations are control-character stripped and length bounded before plain-text Telegram delivery.

Timezone answers when a measurement or event occurred; locale answers how its date, time, number and words are displayed. Selecting Vietnamese never changes the user's timezone. Display-name greetings use that same user's canonical users.display_name; a blank name yields a neutral greeting in the selected language.

The localized Stage 1–6 Beta Summary retains only approved current recovery/derived metric deviations, current episodes, and supported/emerging Journal associations. The typed current readers, receipts, privacy fences, generation authority, SHADOW admission and send dedupe are unchanged. It does not render raw WHOOP/Journal facts, receipts, revisions, worker diagnostics, work tips, family directory, Stage 7 interactions, Stage 8 Owner/Family View, Body Energy, or Body Energy-derived associations.

## Schema allocation

| Version | Owner |
| --- | --- |
| v30 | Stage 6 |
| v31 | Localization |
| v32 | Execution Settlement Authority |
| v33 | Future Stage 7 |
| v34 | Future Stage 8 |

The Stage 5 and Stage 6 freeze tags remain unchanged. Earlier documents reserving v31/v32 for Stage 7/8 describe the historical pre-localization allocation.
