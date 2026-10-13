import {BODY_ENERGY_PROVISIONAL_POLICY} from './bodyEnergyProvisionalPolicy.js';
import {meetsConfidenceThreshold} from './bodyEnergy.js';
import {LOCALES} from './localization.js';
import {safeDisplayName} from './displayName.js';
import {BODY_ENERGY_RELEASE_CRITERIA as CRITERIA} from './bodyEnergyReleaseCriteria.js';
const copy=Object.freeze({
  'zh-TW':{title:'🔋 Body Energy',name:name=>`${name}，`,estimate:'由 Kelvin Health OS 計算的工程估計；不是 WHOOP 官方分數、醫療判斷或持續即時監測。',
    trial:'試用估計／個人基準仍在建立中',limitedQuality:'資料品質：LIMITED（僅基準天數未滿）',baseline:'基準筆數',freshness:'發布時所需資料均在 90 分鐘內',asof:'資料時間',quality:'資料品質：可用',confidence:'資料品質信心（非生理準確度）',drivers:'起始／時間消耗／負荷消耗／小睡回充',algorithm:'演算法',hash:'常數版本識別',alertsOn:'已開啟 Body Energy 通知；只在資料與發布資格合格時通知。',alertsOff:'已關閉 Body Energy 通知。',
    pending:'Body Energy 尚待真實資料品質與獨立發布驗證，現在不提供數字。',unavailable:'目前沒有足夠新鮮且完整的 Body Energy 資料，暫不提供數字。',
    drop:'Body Energy 在新的負荷資料更新後明顯下降。可考慮調整活動與休息；這是健康參考，不是診斷。',
    states:{UNAVAILABLE:'此帳號目前無法取得 Body Energy 所需資料。',WARMING_UP:'個人基準仍在累積，暫不提供數字。',LIMITED:'個人基準或必要資料尚未完整，暫不提供數字。',DEGRADED:'資料品質暫不符合發布條件，暫不提供數字。',STALE:'資料已不夠新鮮，暫不提供數字。',PROCESSING:'資料仍在處理，暫不提供數字。'}},
  en:{title:'🔋 Body Energy',name:name=>`${name}, `,estimate:'An engineering estimate calculated by Kelvin Health OS; not an official WHOOP score, medical judgment or continuous real-time monitoring.',
    trial:'Trial estimate / personal baseline still being established',limitedQuality:'Data quality: LIMITED (baseline length only)',baseline:'Baseline samples',freshness:'Required inputs are within 90 minutes at publication',asof:'As of',quality:'Data quality: available',confidence:'Data-quality confidence (not physiological accuracy)',drivers:'Initial / time depletion / load depletion / nap recharge',algorithm:'Algorithm',hash:'Constants identity',alertsOn:'Body Energy alerts are enabled; notifications require eligible data and publication qualification.',alertsOff:'Body Energy alerts are disabled.',
    pending:'Body Energy is awaiting genuine-data quality and independent publication qualification. No score is shown yet.',unavailable:'Body Energy needs fresh, complete data. No score is available now.',
    drop:'Body Energy dropped noticeably after new load data arrived. Consider adjusting activity and rest; this is wellness context, not a diagnosis.',
    states:{UNAVAILABLE:'This account cannot currently provide the inputs required for Body Energy.',WARMING_UP:'Your personal baseline is still building. No score is shown.',LIMITED:'Your baseline or required inputs are incomplete. No score is shown.',DEGRADED:'Data quality does not currently meet publication requirements. No score is shown.',STALE:'The data is no longer fresh enough. No score is shown.',PROCESSING:'The data is still processing. No score is shown.'}},
  vi:{title:'🔋 Body Energy',name:name=>`${name}, `,estimate:'Ước tính kỹ thuật do Kelvin Health OS tính; không phải điểm WHOOP chính thức, nhận định y khoa hay theo dõi liên tục theo thời gian thực.',
    trial:'Ước tính thử nghiệm / dữ liệu nền cá nhân đang được thiết lập',limitedQuality:'Chất lượng dữ liệu: LIMITED (chỉ thiếu số ngày nền)',baseline:'Số mẫu nền',freshness:'Dữ liệu cần thiết trong vòng 90 phút khi hiển thị',asof:'Dữ liệu lúc',quality:'Chất lượng dữ liệu: đủ điều kiện',confidence:'Độ tin cậy dữ liệu (không phải độ chính xác sinh lý)',drivers:'Ban đầu / hao hụt theo thời gian / hao hụt do vận động / hồi phục sau ngủ ngắn',algorithm:'Thuật toán',hash:'Mã phiên bản hằng số',alertsOn:'Đã bật thông báo Body Energy; chỉ thông báo khi dữ liệu và điều kiện phát hành được phê duyệt.',alertsOff:'Đã tắt thông báo Body Energy.',
    pending:'Body Energy đang chờ xác minh chất lượng dữ liệu thực và phê duyệt độc lập. Chưa hiển thị điểm.',unavailable:'Body Energy cần dữ liệu mới và đầy đủ. Hiện chưa có điểm.',
    drop:'Body Energy giảm đáng kể sau khi có dữ liệu vận động mới. Bạn có thể cân nhắc điều chỉnh hoạt động và nghỉ ngơi; đây là thông tin tham khảo, không phải chẩn đoán.',
    states:{UNAVAILABLE:'Tài khoản hiện chưa cung cấp được dữ liệu cần cho Body Energy.',WARMING_UP:'Dữ liệu nền cá nhân đang tích lũy. Chưa hiển thị điểm.',LIMITED:'Dữ liệu nền hoặc dữ liệu cần thiết chưa đầy đủ. Chưa hiển thị điểm.',DEGRADED:'Chất lượng dữ liệu chưa đáp ứng điều kiện phát hành. Chưa hiển thị điểm.',STALE:'Dữ liệu không còn đủ mới. Chưa hiển thị điểm.',PROCESSING:'Dữ liệu đang được xử lý. Chưa hiển thị điểm.'}},
});
export function renderBodyEnergy(view,{locale,displayName='',alert=false,details=false,sourcePage=1}={}){
  if(!LOCALES.includes(locale))throw Error('BODY_ENERGY_LOCALE_REQUIRED');
  const c=copy[locale],clean=safeDisplayName(displayName).replace(/\p{Cc}/gu,'').replace(/\p{Cf}/gu,ch=>ch==='\u200D'?ch:'');
  const name=[...clean].slice(0,256).join('');
  const provisional=view?.status==='PROVISIONAL';
  if(view?.status!=='AVAILABLE'&&!provisional)return `${c.title}\n${view?.status==='QUALIFICATION_PENDING'?c.pending:c.states[view?.status]??c.unavailable}`;
  if(!Number.isInteger(view.value)||view.value<0||view.value>100||!Number.isFinite(view.confidence)
    ||!meetsConfidenceThreshold(view.confidence,CRITERIA.confidenceMinimum)||view.confidence>1
    ||view.quality!==(provisional?'LIMITED':'AVAILABLE')||provisional&&(view.presentationPolicy!==BODY_ENERGY_PROVISIONAL_POLICY.version||alert)
    ||view.algorithm!==CRITERIA.algorithm||view.constantsHash!==CRITERIA.constantsHash
    ||!Number.isFinite(Date.parse(view.asOfUtc)))throw Error('BODY_ENERGY_PUBLIC_VIEW_INVALID');
  const time=new Intl.DateTimeFormat(locale,{timeZone:view.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(view.asOfUtc));
  const d=view.drivers;if(!d||[d.initialCharge,d.timeDepletion,d.loadDepletion,d.napRecharge].some(x=>!Number.isFinite(x)||x<0))throw Error('BODY_ENERGY_PUBLIC_VIEW_INVALID');
  const counts=view.provenance?.included;
  if(provisional&&(!counts||[counts.hrvBaselineCount,counts.rhrBaselineCount].some(n=>!Number.isSafeInteger(n)||n<7||n>30)
    ||counts.hrvBaselineCount===30&&counts.rhrBaselineCount===30||view.provenance.reasons?.length!==1||view.provenance.reasons[0]!=='BASELINE_LIMITED'))throw Error('BODY_ENERGY_PUBLIC_VIEW_INVALID');
  const n=x=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(x);
  return [`${c.title} — ${name?c.name(name):''}${view.value}/100`,`${c.asof}: ${time} (${view.timezone})`,
    provisional?c.trial:null,provisional?`${c.baseline}: HRV ${counts.hrvBaselineCount}/30 · RHR ${counts.rhrBaselineCount}/30`:null,
    provisional?c.freshness:null,`${provisional?c.limitedQuality:c.quality} · ${c.confidence}: ${n(view.confidence*100)}%`,`${c.drivers}: ${[d.initialCharge,d.timeDepletion,d.loadDepletion,d.napRecharge].map(n).join(' / ')}`,
    alert?c.drop:null,c.estimate,details?renderProvenance(view,c,sourcePage):'/energy — '+c.algorithm+' / '+c.hash].filter(Boolean).join('\n');
}
export function bodyEnergyQueryPage(text){if(typeof text!=='string')return null;const match=/^\/energy(?:@[a-z0-9_]+)?\s+sources\s+(\d{1,3})\s*$/iu.exec(text.trim());return match&&Number(match[1])>=1?Number(match[1]):null;}
function renderProvenance(view,c,page){
  const p=view.provenance;if(!p||!Number.isFinite(Date.parse(view.wakeAtUtc))||!Array.isArray(p.sources)||!Array.isArray(p.excluded)||!Number.isSafeInteger(page)||page<1)throw Error('BODY_ENERGY_PUBLIC_VIEW_INVALID');
  const rows=[...p.sources.map(s=>`${s.type}:${s.id} [${s.roles.join(',')}] updated=${s.updatedAt??'?'} ingested=${s.ingestedAt}${s.providerCreatedAt?' created='+s.providerCreatedAt:''}`),
    ...p.excluded.map(e=>`EXCLUDED ${e.resource}:${e.id??'?'} ${e.reason} updated=${e.source_version?.updated_at??'?'} ingested=${e.source_version?.synced_at??'?'}`)],pages=Math.max(1,Math.ceil(rows.length/10));
  if(page>pages)page=pages;const i=p.included;
  return [`${c.algorithm}: ${view.algorithm}`,`${c.hash}: ${view.constantsHash}`,`health_day=${view.healthDate} wake=${view.wakeAtUtc} timezone=${view.timezone}`,
    `MAIN_SLEEP=${i.mainSleepId} RECOVERY=${i.recoverySleepId} HRV_BASELINE=${i.hrvBaselineCount} RHR_BASELINE=${i.rhrBaselineCount}`,
    `LOAD=${i.loadKind} (${i.loadIds.length}) NAPS=${i.napIds.length} reasons=${p.reasons.join(',')||'-'}`,
    `/energy sources ${page} (${page}/${pages})`,...rows.slice((page-1)*10,page*10)].join('\n');
}
export function isBodyEnergyQuery(text){return bodyEnergyQueryPage(text)!==null||typeof text==='string'&&/^(?:\/energy(?:@[a-z0-9_]+)?|body\s*energy|身體能量|身体能量|năng\s+lượng\s+cơ\s+thể)\s*[?？]?$/iu.test(text.trim());}
export function bodyEnergyControlReply(locale,enabled){if(!LOCALES.includes(locale))throw Error('BODY_ENERGY_LOCALE_REQUIRED');return copy[locale][enabled?'alertsOn':'alertsOff'];}
