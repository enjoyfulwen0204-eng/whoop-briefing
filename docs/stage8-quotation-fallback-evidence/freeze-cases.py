from pathlib import Path
import json,unicodedata
r=Path('/Users/kelvin/.codex/worktrees/stage8-quotation-safety-fallback/whoop-briefing');out=r/'test/stage8-quotation-fallback';C='CURRENT_URGENT';P='POSSIBLE_CURRENT_URGENT';N='CLEARLY_NONURGENT'
data=[
('current-en','en','"chest pain" is precisely what I am feeling now.',C),
('current-zh','zh-TW','「胸悶」就是我現在感到的症狀。',C),
('current-vi','vi','"tức ngực" đúng là triệu chứng tôi đang cảm thấy.',C),
('current-mixed','en','「胸痛」 is exactly what I am experiencing now.',C),
('uncertain-en','en','"chest pain" might be what I am experiencing now.',P),
('uncertain-zh','zh-TW','「胸痛」可能是我現在感到的症狀。',P),
('uncertain-vi','vi','"đau ngực" có thể là triệu chứng tôi đang cảm thấy.',P),
('unproven-en','en','"chest pain" sounds like what I am feeling now.',P),
('unproven-zh','zh-TW','「胸痛」好像我現在感到的症狀。',P),
('unproven-vi','vi','"đau ngực" giống điều tôi đang cảm thấy.',P),
('negated-en','en','"chest pain" is precisely what I am not experiencing now.',N),
('negated-zh','zh-TW','「胸痛」正是我現在沒有感到的症狀。',N),
('negated-vi','vi','"đau ngực" đúng là triệu chứng tôi không cảm thấy.',N),
('history-en','en','"chest pain" is what I experienced last year.',N),
('history-zh','zh-TW','「胸痛」是我昨天感到的症狀。',N),
('history-vi','vi','"đau ngực" là triệu chứng tôi cảm thấy hôm qua.',N),
('resolved-en','en','I had "chest pain" last year, and it completely resolved.',N),
('resolved-zh','zh-TW','我昨天「胸痛」，現在已經好了。',N),
('resolved-vi','vi','Tôi đã hết hẳn "đau ngực".',N),
('reading-en','en','I am reading about "chest pain".',N),
('reading-zh','zh-TW','我正在閱讀「胸痛」。',N),
('reading-vi','vi','Tôi đang đọc về "đau ngực".',N),
('learning-en','en','I am learning about "chest pain".',N),
('learning-zh','zh-TW','我想知道「胸痛」是什麼意思。',N),
('learning-vi','vi','Tôi đang tìm hiểu về "đau ngực".',N),
('question-en','en','What causes "chest pain" in general?',N),
('question-zh','zh-TW','「胸痛」通常是什麼原因？',N),
('question-vi','vi','Nguyên nhân "đau ngực" thường là gì?',N),
('hypothetical-en','en','If "chest pain" is what I am experiencing, what should I do?',N),
('hypothetical-zh','zh-TW','假設「胸痛」是我現在感到的症狀。',N),
('hypothetical-vi','vi','Nếu "đau ngực" là triệu chứng tôi đang cảm thấy.',N),
('unrelated-object-en','en','"chest pain" is a phrase I am feeling refreshed now.',N),
('unrelated-object-zh','zh-TW','「胸痛」是一個詞我現在覺得很放鬆。',N),
('unrelated-object-vi','vi','"đau ngực" là một cụm từ tôi đang cảm thấy dễ chịu.',N),
('unrelated-sentence-en','en','"chest pain". I am feeling calm now.',N),
('unrelated-sentence-zh','zh-TW','「胸痛」。我現在覺得很放鬆。',N),
('unrelated-sentence-vi','vi','"đau ngực". Tôi đang cảm thấy dễ chịu.',N),
('unrelated-activity-en','en','"chest pain" I am busy now.',N),
('unrelated-activity-zh','zh-TW','「胸痛」我現在忙碌。',N),
('unrelated-activity-vi','vi','"đau ngực" tôi đang làm việc.',N),
('standalone-en','en','"I have chest pain now"',N),
('standalone-zh','zh-TW','「我現在胸痛」',N),
('standalone-vi','vi','"Tôi đang đau ngực"',N),
('metric-en','en','"chest pain" What is my HRV today?',N),
('other-assertion','en','"chest pain" is exactly what my friend Ana is experiencing now.',C),
('other-unrelated','en','My friend Ana said "chest pain". I am feeling relaxed now.',N),
]
cases=[dict(id=i,locale=l,text=t,expected=e) for i,l,t,e in data]
meta=[]
for c in cases:
 variants={'nfd':unicodedata.normalize('NFD',c['text']),'space':'  '+c['text']+'  ','quote-style':c['text'].replace('"','“',1) if False else c['text'].replace('「','『').replace('」','』'),'metric':c['text']+' What is my HRV today?'}
 # Curly quotation marks are normalized at the existing ingress boundary.
 if '"' in c['text']:
  n=0;chars=[]
  for ch in c['text']:
   if ch=='"':chars.append('“' if n%2==0 else '”');n+=1
   else:chars.append(ch)
  variants['quote-style']=''.join(chars)
 for suffix,text in variants.items():meta.append({**c,'id':c['id']+'-'+suffix,'text':text,'transformation':suffix})
value={'expectationsFrozenBeforeRuntimeEdit':True,'baselineHead':'10b68fa5f4f9501c424ad4c16b4bab0eae500595','cases':cases,'metamorphic':meta}
(out/'cases.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');Path('/private/tmp/stage8-quotation-fallback/frozen-cases.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n');print(len(cases),'base',len(meta),'metamorphic')
