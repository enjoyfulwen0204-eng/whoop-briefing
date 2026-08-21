# WHOOP 每日 AI 恢復簡報

每天在你「真正起床後 30 分鐘」，抓 WHOOP 數據、跟你自己的個人基準比較，由 Claude 用溫和女教練的口吻寫成一則簡報，推到 Telegram。每週一另外發一則上週回顧；數據連續走低時會在當天簡報裡加上趨勢預警。

```
🌅 早安，Kelvin
恢復 38%🔴⚠️

📊 指標 vs 你的基準
❤️ HRV 38ms（基準 55ms）🔴⚠️
💓 靜息心率 58bpm（基準 51bpm）🔴⚠️
🫁 呼吸率 16.8（基準 15.2）🔴⚠️
🌙 睡眠 4h30m（基準 7h06m）🔴⚠️
😴 深睡 54m（基準 1h30m）🔴⚠️
🧠 REM 1h00m（基準 1h36m）🔴⚠️
📈 睡眠表現 68%（基準 91%）🔴⚠️
⏳ 睡眠債加成 +95m（基準 +12m）🟡
🔥 昨日 Strain 10.7（基準 12.9）

📉 趨勢提醒（多項生理訊號同時偏離）
· HRV 連續偏離且逐日變差：50ms → 47ms → 38ms
· 靜息心率 逐日變差：54bpm → 55bpm → 58bpm
—
[Claude 教練的話]

8/21（五） · 基準 30/30 筆
```

---

## 這東西怎麼運作（30 秒版）

1. 一台雲端排程器（Render Cron Job）**每 15 分鐘**執行一次這支程式，時間窗是台灣時間每天 05:00–15:45。
2. 每次執行先問 Turso 資料庫：「今天的簡報發過了嗎？」發過就直接結束，連 WHOOP 都不打。
3. 沒發過 → 抓最新的睡眠與恢復資料，判斷「你是不是真的起床了」（最新主睡眠已評分、對應的 recovery 已評分、而且距離睡眠結束已超過 30 分鐘）。
4. 條件成立 → 才抓 45 天歷史，算出你的個人基準、紅黃燈、趨勢，然後請 Claude 把結果講成人話，發到 Telegram，並在 Turso 記一筆「已送出」。
5. 週一時，每週回顧走**完全獨立**的一條線判斷與重試，跟每日簡報互不影響。

因為每 15 分鐘都會試一次，加上「已送出」紀錄存在資料庫（不是存在檔案裡），所以：**你幾點起床就幾點收到（誤差 15 分鐘內），一天只會收到一則，中間任何一次失敗下一輪會自動重試。**

---

## 檔案在幹什麼

| 檔案 | 用途 |
|---|---|
| `src/config.js` | **所有門檻與設定都在這裡**。紅黃燈的百分比、冷啟動筆數、指標怎麼取值與顯示。要調整敏感度只改這一個檔。 |
| `src/index.js` | 進入點。判斷今天有沒有事要做，然後分別跑 daily 與 weekly（兩者互不阻擋）。 |
| `src/whoop.js` | WHOOP OAuth 與 v2 API。token 重用/更新、分頁、429 backoff、401 自動重試。 |
| `src/db.js` | Turso（libSQL）。存 token、發送紀錄、錯誤通知冷卻。 |
| `src/analyze.js` | **所有數值判斷**。起床偵測、基準計算、三級嚴重度、趨勢預警、週統計。 |
| `src/daily.js` | 每日簡報流程。 |
| `src/weekly.js` | 每週回顧流程。 |
| `src/format.js` | 組 Telegram 訊息（plain text、4096 字元上限）。 |
| `src/coach.js` | 呼叫 Claude。system prompt、要餵給它的「已算好的結論」、參數階梯。 |
| `src/telegram.js` | 推送與錯誤通知（含 2 小時冷卻）。 |
| `src/dataSource.js` | WHOOP 資料取用層。polling 只抓最新，歷史只在要發報告時抓一次並共用。 |
| `src/time.js` | 時區工具。UTC 與 Asia/Taipei 的分工都在這裡。 |
| `src/logger.js` | 結構化 log，自動遮蔽 token/key。 |
| `scripts/authorize.js` | **一次性** WHOOP 授權（本機跑一次）。 |
| `scripts/migrate.js` | 建 Turso 資料表（可重複跑）。 |
| `scripts/preflight.js` | 一鍵檢查四個服務都通。 |
| `scripts/probe-fields.js` | 看你的 WHOOP 帳號實際回傳哪些欄位。 |
| `scripts/dry-run.js` | 用假資料把各種情境跑一遍，直接看到訊息長相。 |
| `test/` | 63 個自動化測試。 |
| `render.yaml` | Render 部署藍圖（可選）。 |
| `.github/workflows/briefing.yml` | 用 GitHub Actions 排程的備案（可選）。 |

---

## 本機怎麼測

```bash
npm install

# 1. 完全離線：用假資料看各種情境的訊息長相（不需要任何帳號、不花錢）
npm run dry-run

# 2. 跑全部自動化測試
npm test

# 3. 想看真的 Claude 寫出來的教練文字（需要 .env 裡有 ANTHROPIC_API_KEY，花幾分錢）
npm run dry-run -- --live

# 4. 四個服務都設定好之後，一鍵健康檢查（會發一則測試訊息到 Telegram）
npm run check

# 5. 看你的 WHOOP 帳號實際有哪些欄位（WHOOP One 可能沒有 SpO2 / 皮膚溫度）
npm run probe

# 6. 手動完整跑一次真的流程（會真的發簡報，如果條件成立）
npm start
```

`.env` 從 `.env.example` 複製一份來填。`.env` 已經在 `.gitignore` 裡，不會進 git。

---

## 設計上的重要決定（為什麼這樣做）

### 狀態全部存 Turso，不存檔案
雲端排程器的檔案系統是 ephemeral（每次執行都是全新的），寫進檔案的東西下次就不見了。所以 WHOOP token、發送紀錄、錯誤冷卻全部在 Turso。

### Token 不會每次都 refresh
access token 只要還有 **5 分鐘以上**效期就直接重用。真的快過期才 refresh，而且 refresh 成功後**第一件事**就是把新的 access/refresh token 寫回 Turso —— 寫成功前不做任何 WHOOP 資料處理。這一步很關鍵：WHOOP 每次 refresh 都會換一組新的 refresh_token，舊的立刻失效；如果拿到新 token 卻沒存下來就去撈資料然後中途掛掉，整個授權就死了，得重新跑一次授權腳本。DB 寫入失敗會重試 4 次，全失敗就中止本次執行（寧可今天不發，也不要把授權弄壞）。

跨系統無法真原子，所以另外靠兩件事避免競態：同一次執行內用 mutex 保證只 refresh 一次，以及排程器保證同一時間只有一個 run。

### 起床偵測用 UTC，「今天」用台灣時間
「距離起床是否超過 30 分鐘」是**時間長度**問題，直接比 UTC timestamp，不碰時區。「今天的簡報發過沒」和訊息上的日期是**日曆**問題，一律用 `TIMEZONE`（預設 Asia/Taipei）算。Cron 一律用 UTC 設定。

你去越南（UTC+7）出差時的 1 小時時差，被 05:00–15:45 這個寬視窗吸收掉了，程式裡沒有任何特例邏輯。

### 基準是「最近 30 筆有效紀錄」，不是 30 天
缺資料的日子（沒戴錶、沒同步）不該算進去，所以抓最近 45 天再挑出最近 30 筆有效的。而且：

- **一律不含今天**（不然今天的數值會被自己拉平）
- 只用 `score_state === "SCORED"` 的資料
- 睡眠基準排除 `nap === true`（只用主睡眠）
- 排除 `user_calibrating === true` 的 recovery（WHOOP 校正期的數字不可信）
- 每個指標各自算自己的 30 筆（某天有睡眠資料但沒有 HRV，不會互相污染）

### 冷啟動分三階
| 有效筆數 | 行為 |
|---|---|
| < 7 | 只顯示今天的數據，**不給紅黃燈**，也不顯示還不可信的基準，標「個人基準建立中」 |
| 7–29 | 用現有資料當「暫定基準」，給燈，標「基準建立中 n/30」 |
| ≥ 30 | 正式基準 + 啟用趨勢預警 |

另外每個指標自己也要有至少 7 筆樣本才會給燈。

### 紅黃燈是 Node 算的，Claude 只講話
所有比較、基準、趨勢、三級嚴重度都由 `src/analyze.js` 用寫死的門檻算完，才把「結論」交給 Claude。Claude 的 system prompt 明確禁止它自己判斷好壞。這樣簡報永遠不會出現「數據是綠燈但教練說你很糟」這種矛盾。

門檻（在 `src/config.js` 最上方）：

| 指標 | 黃燈 | 紅燈 |
|---|---|---|
| 一般越高越好（恢復、睡眠總時長、深睡、REM、睡眠表現、睡眠一致性、睡眠效率） | < -8% | < -18% |
| HRV | < -7% | < -15% |
| 靜息心率 | > +5% | > +10% |
| 呼吸率 | > +4% | > +8% |
| 睡眠債加成 | 比基準多 30 分 | 比基準多 90 分 |
| 擾動次數（越低越好） | > +8% | > +18% |
| SpO2、皮膚溫度、昨日 Strain | 不給燈，只顯示數值與差異 |

睡眠債加成刻意**不除以基準**——基準可能是 0，會直接爆掉，所以用絕對分鐘差。皮膚溫度不給燈是因為它是「偏離」問題而不是「越高越差」，規則之後再定。

### 欄位定義
- **睡眠總時長** = light + slow_wave（深睡）+ REM。不含 awake / no-data，也不是 `total_in_bed_time`。
- **睡眠債加成** = `sleep_needed.need_from_sleep_debt_milli`。
- **昨日 Strain** = 上一個**已完成**（`end` 不是 null）cycle 的 day strain。不是今天剛起床那個還在跑的 cycle（那個 strain 幾乎是 0）。
- 沒有硬寫死所有欄位：`npm run probe` 會告訴你這個帳號實際回傳什麼。核心指標缺就顯示「無資料」；選配指標（SpO2、皮膚溫度、睡眠一致性、睡眠效率、擾動次數）沒有就整行不出現。

### 趨勢預警只在真的明顯時才叫
兩種模式：

- **A 持續偏低**：某指標連續 3 個資料點都超出門檻。
- **B 持續惡化**：某指標連續 3 個資料點逐日變差，**而且最新那一點已經超出門檻**。

B 後面那個條件是刻意加的。只看「是否單調下降」的話，在基準附近正常波動也會隨機湊出連續 3 點下降（機率大約 1/6），四個指標一起看幾乎每天都會亮，兩天就沒人想看了。

兩個以上生理訊號同時異常（HRV↓ 且 RHR↑、或 HRV↓ 且呼吸率↑）會標成較強提醒，Claude 也會收到「強度：較強」而講得更慎重一點。預警只在正式基準（≥30 筆）階段啟用，並且融進當天簡報，不另外發訊息。

### Claude 的呼叫方式
- 模型走 `ANTHROPIC_MODEL`，預設 `claude-sonnet-5`。想更省可以改成 `claude-haiku-4-5-20251001`。
- `thinking: { type: "disabled" }` + `output_config: { effort: "low" }`。這種教練文字不需要深度推理，關掉省 token。
- **不設** `temperature` / `top_p` / `top_k`（Sonnet 5 設非預設值會直接回 400）。語氣完全靠 system prompt 控制。
- 萬一換的模型不吃某個參數，程式會自動退一階再試（`PARAM_TIERS`），不會整份簡報消失。

### 壞掉的時候會怎樣
| 壞的東西 | 行為 |
|---|---|
| Claude 掛了 | **照樣發數據簡報**，底下加「⚠️ AI 教練分析今天暫時無法生成，數據簡報仍正常」 |
| WHOOP 掛了 | 寫 log + 發 Telegram 錯誤通知，這一輪不發簡報，下一輪（15 分鐘後）自動重試 |
| Turso 掛了 | 同上 |
| Telegram 掛了 | **只寫 log，絕不再呼叫 Telegram**（不然會無窮遞迴）。記一筆 FAILED，下一輪重試 |
| WHOOP 回 429 | 依 `Retry-After` / `X-RateLimit-Reset` 或指數退避重試，最多 4 次 |
| WHOOP 回 401 | 自動 refresh 一次再試；還是 401 就明確告訴你需要重新授權 |

錯誤通知有 **2 小時冷卻**：同一種錯誤 2 小時內最多通知你一次，不會每 15 分鐘洗版。

---

## 資料庫長什麼樣

```sql
whoop_tokens         -- 只有一列：access_token / refresh_token / 到期時間 / scope
report_runs          -- 每次發送的紀錄：report_type / local_date / sleep_id / cycle_id
                     --   / telegram_message_id / status(SENT|FAILED|SKIPPED) / sent_at
error_notifications  -- 錯誤通知冷卻：error_type / last_notified_at / hits
```

`report_runs` 上有一個 partial unique index（`report_type, local_date` where `status='SENT'`），所以就算程式邏輯出錯，資料庫也會擋掉重複發送。`daily` 用日期當 key、`weekly` 用「上週一的日期」當 key，兩者天然獨立。

想看發送歷史：

```sql
SELECT report_type, local_date, status, detail, sent_at
FROM report_runs ORDER BY id DESC LIMIT 20;
```

---

## 之後想調整的地方

- **簡報太囉唆／太簡短** → `src/coach.js` 的 `SYSTEM_PROMPT`（字數要求就寫在裡面）。
- **燈太容易亮／太不容易亮** → `src/config.js` 最上方的 `THRESHOLDS`。
- **想加或移除指標** → `src/config.js` 的 `METRICS` 陣列，加一筆就好（`tier: 'optional'` 表示沒資料就不顯示）。
- **想更省錢** → `ANTHROPIC_MODEL=claude-haiku-4-5-20251001`。
- **時間窗想改** → 改 cron（記得是 UTC）。程式不用動。
- **每週回顧想改成別的星期** → `src/config.js` 的 `WEEKLY.WEEKDAY`。
