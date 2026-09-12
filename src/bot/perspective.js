/**
 * 這一題是在問誰？（視角解析）
 *
 * ## 為什麼需要這一層
 *
 * 上一輪把「關鍵字出現不等於事情發生過」修好了：解析器要明確回報
 * `about_self`，Journal 才會寫入。但那個訊號**只用來保護寫入**，沒有流進
 * 回答規劃。於是：
 *
 *   使用者：我朋友喝酒後很累是正常的嗎？
 *   Bot  ：你會覺得累…（接著列出**使用者自己**的睡眠、恢復、HRV）
 *
 * 一筆 Journal 都沒寫（寫入保護是對的），但人稱錯了，而且把使用者的個人
 * 生理數據拿去回答一個關於別人的問題。那是視角錯誤，也是個人資料誤用。
 *
 * ## 這一層的核心不變量
 *
 *   **使用個人 WHOOP 資料需要「正面確立」這題在問使用者本人。**
 *
 * 不是「沒有證據說不是他」就可以用 —— 那是 fail open。缺主詞、主詞衝突、
 * 泛稱人稱，一律不得動用個人資料。這個方向刻意跟 Journal 寫入閘門一致：
 * 兩者都要求正面授權。
 *
 * ## 誰有權下修
 *
 * 文字裡的第一人稱是**確定性證據**，LLM 不能靠自己的判斷把一個沒有主詞的
 * 句子升級成「在問他自己」。反過來，LLM 說 `about_self: false` 時可以把
 * 一個看起來像自述的句子**下修**成 ambiguous —— 下修永遠安全（頂多少用
 * 個人資料），上修則會洩漏資料。
 */

/** 視角。usePersonalData() 只對 SELF 回 true。 */
export const PERSPECTIVE = Object.freeze({
  /** 在講／在問使用者自己。 */
  SELF: 'self',
  /** 在講一個特定的其他人（朋友、家人、他／她）。 */
  THIRD_PARTY: 'third_party',
  /** 一般性、衛教性的問題，沒有特定對象。 */
  GENERAL: 'general',
  /** 主詞不明，或訊號互相矛盾。一律當成「不可以用個人資料」。 */
  AMBIGUOUS: 'ambiguous',
});

/** 「我＋關係詞」= 那個人不是使用者本人。 */
const RELATION = '朋友|同事|老婆|老公|先生|太太|男友|女友|小孩|兒子|女兒|爸|媽|哥|姐|姊|弟|妹'
  + '|家人|室友|同學|主管|老闆|客戶|阿公|阿嬤|爺爺|奶奶|長輩|另一半';

/** 明確指向某一個其他人。 */
const THIRD_SPECIFIC = new RegExp(`(我(們)?(的)?(${RELATION}))|(他|她)(們)?|那個人|某某`);

/** 泛稱的人 —— 這通常是衛教問題，不是在問某個特定的人。 */
const GENERIC_PEOPLE = /(有人|有些人|別人|大家|一般人|人們|每個人|正常人)/;

/**
 * 一般性問句的形狀（沒有主詞也成立）。
 *
 * 「壓力可能讓 HRV 改變嗎？」沒有主詞，卻被 intent 判成 trend_query —— 如果
 * 只看 intent 就會拿使用者的 HRV 歷史去回答一個一般性問題。所以句型本身
 * 必須是獨立的證據。
 */
const GENERAL_FORM = new RegExp(
  '(會不會|通常|一般來說|一般而言|正常嗎|常見嗎|是什麼原因|什麼原因|原理|機制)'
  + '|(為什麼.{0,8}(會|容易))'
  + '|((會|可能|能不能|是否|容易).{0,4}(讓|影響|造成|導致|變差|變好|下降|上升|降低|提高|改變))',
);

/**
 * 假設語氣。「如果我喝酒，隔天 recovery 會變差嗎？」有第一人稱，但它問的
 * 不是一件發生過的事，所以沒有任何個人量測可以拿來回答 —— 那是衛教問題。
 *
 * ⚠️ 這裡**只認明確的條件連接詞**，不認裸的「的話」。
 *
 * 上一版把「的話」當成假設語氣的證據，於是這些句子全被誤判成一般衛教問題：
 *
 *   你的話讓我安心 ／ 老實說的話，我今天很累 ／ 我的話是指今天的 recovery
 *   ／ 照你的話做 ／ 有資料的話再告訴我 ／ 喝酒的話題先不要談
 *
 * 「的話」在中文裡既是條件句的尾綴，也是「你說的話」這個名詞 —— 光靠子字串
 * 分不開。而**事件是否假設**與**整句的意圖**是兩件不同的事：前者由
 * journalAuthorization 用「線索詞後面緊跟的話」判斷（那個位置只可能是條件），
 * 後者只在有明確連接詞時才轉向衛教。
 */
const HYPOTHETICAL = /(如果|假如|要是|假設|萬一|若是|倘若)/;

/** 第一人稱，但排除「我朋友」「我的同事」這種**別人**的情況。 */
const SELF_MARK = new RegExp(`我(?!(們)?(的)?(${RELATION}))`);

/**
 * 解析視角。
 *
 * @param {string} text 使用者原話（唯一的確定性證據來源）
 * @param {?object} signals 解析器回報的結構化訊號（可能沒有：不是每一句都會去解析）
 *   signals.aboutSelf — 解析器認為這句話在講使用者自己嗎
 * @returns {{perspective:string, usePersonalData:boolean, source:string, cues:string[]}}
 */
export function resolvePerspective({ text, signals = null } = {}) {
  const t = String(text ?? '');
  const cues = [];

  const hypothetical = HYPOTHETICAL.test(t)
    || (signals && signals.hypothetical === true);
  const third = THIRD_SPECIFIC.test(t);
  const generic = GENERIC_PEOPLE.test(t);
  const selfMark = SELF_MARK.test(t);
  const generalForm = GENERAL_FORM.test(t);
  if (third) cues.push('third_person');
  if (generic) cues.push('generic_people');
  if (selfMark) cues.push('first_person');
  if (generalForm) cues.push('general_form');

  // 1) 有明確的另一個人 —— 即使句子裡也有「我」（「我朋友…」），主詞仍然是那個人。
  //    泛稱（有人／大家）不算特定的第三人，那是衛教問法。
  if (third && !generic) return plan(PERSPECTIVE.THIRD_PARTY, 'text_third_person', cues);

  // 2) 泛稱人稱 = 衛教。放在第一人稱之前：「有人喝酒後 HRV 會降低嗎」即使
  //    出現「我」也不是在問自己的數據。
  if (generic) return plan(PERSPECTIVE.GENERAL, 'text_generic_people', cues);

  // 3) 假設語氣 —— 沒有發生過的事就沒有個人量測可談，一律走衛教。
  //    放在第一人稱之前：「如果我喝酒…」的主詞是使用者，但問題不是。
  if (hypothetical) {
    cues.push('hypothetical');
    return plan(PERSPECTIVE.GENERAL, 'hypothetical', cues);
  }

  // 4) 第一人稱。解析器明確說「不是在講他自己」時**下修**，不上修。
  if (selfMark) {
    if (signals && signals.aboutSelf === false) {
      cues.push('parser_disagrees');
      return plan(PERSPECTIVE.AMBIGUOUS, 'conflict_parser_not_self', cues);
    }
    return plan(PERSPECTIVE.SELF, 'text_first_person', cues);
  }

  // 5) 沒有主詞。一般問句形狀 → 衛教；其餘 → 不明。
  //    兩者都不得動用個人資料，差別只在回答的語氣。
  if (generalForm) return plan(PERSPECTIVE.GENERAL, 'text_general_form', cues);
  return plan(PERSPECTIVE.AMBIGUOUS, 'no_subject', cues);
}

function plan(perspective, source, cues) {
  return {
    perspective,
    /** ★ 只有 SELF 可以動用個人 WHOOP 資料。其餘一律 false。 */
    usePersonalData: perspective === PERSPECTIVE.SELF,
    source,
    cues,
  };
}

/**
 * 這個 intent 本質上就是在問使用者自己的帳號嗎？
 *
 * 「因為數據不夠嗎」「WHOOP 有同步成功嗎」「今天 HRV 多少」沒有第一人稱，
 * 但它們**明確在問使用者自己的量測與歷史** —— 那正是規格允許動用個人資料
 * 的第二種情況。這類 intent 不經過視角解析（也不該經過：它們沒有別的對象
 * 可以問）。
 *
 * 只有「解釋原因」這一族需要視角，因為只有它會被拿來問別人和問一般狀況。
 */
const INHERENTLY_PERSONAL = new Set([
  'today_status', 'trend_query', 'sleep_quality', 'best_worst_day', 'what_changed',
  'readiness_query', 'sync_status', 'current_hr', 'data_status', 'journal_recall',
]);

export function intentIsInherentlyPersonal(intent) {
  return INHERENTLY_PERSONAL.has(String(intent ?? ''));
}
