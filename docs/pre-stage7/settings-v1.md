# Settings v1 implementation candidate

This is the first UX patch after Public Beta stabilization. Review/deploy it separately from Core Repair. No production settings, locale, name, webhook registration or Telegram message changed in this engineering session. Stage 7 Quick Actions/TRUSTED_REGISTRY and Stage 8 remain separate; schema remains v32.

## Product behavior

`/settings` opens a compact menu, `/language` opens the language chooser, and `/name` begins display-name editing. Every native inline button has a visible emoji icon. An UNSET legacy account can reach the three-language chooser without WHOOP reauthorization. A saved language governs the next Settings reply and subsequent Morning Brief, Coach, Journal and Beta Summary. Confirmation persists only `user_locales`; no user data, authorization or name reset. Name confirmation persists only canonical `users.display_name`, never a Telegram username. A blank name retains the existing neutral greeting.

| Action | zh-TW | en | vi |
|---|---|---|---|
| Language | 🌐 更改語言 | 🌐 Change Language | 🌐 Đổi ngôn ngữ |
| Name | ✏️ 更改顯示名稱 | ✏️ Change Display Name | ✏️ Đổi tên hiển thị |
| Back | ⬅️ 返回 | ⬅️ Back | ⬅️ Quay lại |
| Cancel | ❌ 取消 | ❌ Cancel | ❌ Hủy |
| Confirm | ✅ 確認 | ✅ Confirm | ✅ Xác nhận |
| Save | ✅ 儲存 | ✅ Save | ✅ Lưu |
| Edit | ✏️ 編輯名稱 | ✏️ Edit Name | ✏️ Sửa tên |

The chooser uses 🇹🇼 繁體中文 / 🇺🇸 English / 🇻🇳 Tiếng Việt. It previews the selection and requires confirmation. Name entry previews normalized text before Save; Edit, Back and Cancel are available. No custom image keyboard dependency exists.

## Storage, authorization and expiry

Reuse one expiring profile-only row in existing `telegram_state`, keyed by a SHA256 of the canonical user ID. The session contains canonical actor/chat/lifecycle, random 128-bit nonce, revision, mode, expected saved profile, pending choice and a 15-minute expiry. Callback data contains only a narrow `sv1` nonce/revision/action, at most 64 UTF-8 bytes; no user ID or arbitrary command. Every state-changing action re-resolves the active private chat and canonical lifecycle inside the existing operation transaction. Telegram transport rejects bots, group/foreign actors and mismatched sender/chat. Stale nonce/revision/message, unsupported action/locale, wrong actor or lifecycle ABA cannot change a profile.

The existing durable Telegram operation, update claim and conversation lane provide atomic action receipts and reply ordering. Restart during editing resumes existing storage. Repeated confirmation is idempotent. Concurrent saved profile changes are compared before mutation and rejected; a new session invalidates older buttons. Cancel clears only the session. Expired/malformed metadata is cleared and ordinary Coach/Journal text continues routing. Errors reveal no foreign profile or health content.

Names use NFC, trim surrounding whitespace, collapse internal whitespace and require well-formed Unicode with a letter, number or symbol. Reject controls/surrogates/directional/invisible formatting (ZWJ permitted for emoji), empty values, more than 64 grapheme clusters or more than 256 UTF-8 bytes. Both limits apply. Parameterized existing SQL prevents injection. Telegram sends plain text with no parse mode, so HTML/Markdown characters remain literal. All other consumers retain their existing escaping/rendering boundaries.

Callbacks are acknowledged early, best effort, with a three-second bound. Failed acknowledgments cannot roll back or repeat business effects. Definite pre-send errors remain retryable; uncertain sends are durably ambiguous and never retransmitted automatically. Lost COMMIT acknowledgments reconcile existing receipts after lease recovery, rather than executing a second profile update.

## Review and rollout evidence

Focused tests cover all localized labels, routing, language/name persistence, cancel/back/edit/save, duplicate/expired/foreign callbacks, missing locale/name/lifecycle, malformed Unicode, concurrent tenants/profile changes, SQL literal input, rollback on failed updates, lifecycle ABA, restart, uncertain COMMIT, ambiguous delivery and acknowledgment failures. Product tests run three-user Morning Brief through real HTTP/Hrana and canonical router Journal/Coach paths. The Beta consumer test uses a clearly synthetic typed-projection seam plus real canonical profile lookup, report claim/delivery and dedupe; it does not claim production Stage 6 approval.

The comprehensive engineering report and hashed evidence index distinguish original failures, corrected reruns, native driver crashes and production prerequisites. No local suite grants production approval.

After Public Beta gates and separate Settings review: deploy exact B identity, preserve original credentials/v32/OFF controls as reviewed, verify webhook and polling accept `message` plus `callback_query`, keep `max_connections=1` and pending updates, and perform separately authorized private-user command/button smoke in each locale. Never run `telegram:webhook:set` as part of local testing against real Telegram. Roll back Settings using the reviewed Core A binary/profile without schema downgrade; existing expiring session rows remain inert and ordinary commands/briefing continue.
