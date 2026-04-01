import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: true } };

/* ── 공정별 단가 자동 집계 ── */
async function getAutoMarketRefs(region) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: logs, error } = await supabase
      .from('estimate_logs')
      .select('region, area_py, analysis_result')
      .not('analysis_result', 'is', null)
      .limit(2000);

    if (error || !logs || logs.length < 30) return null;

    const CAT_MAP = {
      '철거':'철거/방수','방수':'철거/방수','철거/방수':'철거/방수',
      '창호':'창호/샷시','샷시':'창호/샷시','새시':'창호/샷시',
      '확장':'확장/설비','설비':'확장/설비','보일러':'확장/설비',
      '목공':'목공','우물천장':'목공','가벽':'목공',
      '바닥':'바닥재','마루':'바닥재','장판':'바닥재',
      '도배':'도배','도장':'도장','페인트':'도장','타일':'타일',
      '욕실':'욕실','화장실':'욕실','주방':'주방','싱크대':'주방',
      '붙박이':'가구/붙박이장','가구':'가구/붙박이장','드레스룸':'가구/붙박이장',
      '전기':'조명/전기','조명':'조명/전기',
      '기업이윤':'기업이윤','이윤':'기업이윤',
    };

    function getCategory(name) {
      if (!name) return null;
      for (const [k, v] of Object.entries(CAT_MAP)) {
        if (name.includes(k)) return v;
      }
      return null;
    }

    function normalizeToPerPy(cat, amount, py) {
      if (!py || py === 0) return null;
      const perPy = ['바닥재','도배','도장','목공','조명/전기','철거/방수'];
      const perM2 = ['타일'];
      if (perPy.includes(cat)) return Math.round(amount / py * 10) / 10;
      if (perM2.includes(cat)) return Math.round(amount / (py * 3.3) * 10) / 10;
      return amount;
    }

    function normalizeRegion(r) {
      if (!r) return null;
      if (r.includes('서울')) return '서울';
      if (r.includes('수도권') || r.includes('경기') || r.includes('인천')) return '수도권';
      if (['부산','대구','광주','대전','울산'].some(c => r.includes(c))) return '광역시';
      return null;
    }

    const buckets = {};
    for (const log of logs) {
      const rk = normalizeRegion(log.region);
      if (!rk) continue;
      for (const item of (log.analysis_result?.items || [])) {
        const cat = getCategory(item.name) || getCategory(item.category);
        if (!cat || !item.amount) continue;
        const norm = normalizeToPerPy(cat, item.amount, log.area_py);
        if (!norm || norm <= 0 || norm > 10000) continue;
        if (!buckets[cat]) buckets[cat] = { 서울:[], 수도권:[], 광역시:[] };
        if (buckets[cat][rk]) buckets[cat][rk].push(norm);
      }
    }

    const targetRegion = region?.includes('서울') ? '서울'
      : region?.includes('수도권') ? '수도권'
      : region?.includes('광역시') ? '광역시' : '서울';

    const lines = [];
    for (const [cat, regions] of Object.entries(buckets)) {
      const values = regions[targetRegion] || regions['서울'] || [];
      if (values.length < 20) continue;
      const sorted = [...values].sort((a,b) => a-b);
      const q1 = sorted[Math.floor(sorted.length*0.25)];
      const q3 = sorted[Math.floor(sorted.length*0.75)];
      const iqr = q3 - q1;
      const filtered = sorted.filter(v => v >= q1-1.5*iqr && v <= q3+1.5*iqr);
      const min = Math.round(filtered[0]);
      const max = Math.round(filtered[filtered.length-1]);
      const avg = Math.round(filtered.reduce((a,b)=>a+b,0)/filtered.length);
      lines.push(`· ${cat} ${targetRegion}기준 ${min}~${max}만 (평균${avg}만, n=${filtered.length})`);
    }

    return lines.length >= 3 ? lines.join('\n') : null;

  } catch (err) {
    console.error('auto pricing error:', err.message);
    return null;
  }
}

const DEFAULT_MARKET_REFS = `Market refs per 평:
· 철거 평당15~25만 · 방수(발코니) m2당8~15만
· 욕실타일 개소당100~200만 · 주방벽타일 m2당6~12만
· 강마루 m2당4~8만 · 원목마루 m2당8~15만 · 장판 m2당2~4만
· 도배(실크) 평당3~5만 · 도배(합지) 평당2~3만 · 도장 m2당2~4만
· 욕실리모델링 개소당250~600만 · 양변기 30~80만 · 세면대 20~60만
· 싱크대상부장 m당30~80만 · 싱크대하부장 m당40~100만
· 붙박이장 90cm폭당60~150만 · 드레스룸 200~600만/식
· 전기배선 평당10~20만 · 조명교체 평당3~7만
· 발코니새시 150~400만/식 · 현관문 80~200만
· 목공(몰딩) 평당5~11만 · 목공(우물천장) m2당10~22만
· 보일러 50~150만/식 · 발코니확장 평당150~350만`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    /* body 안전하게 파싱 */
    const raw = req.body;
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    /* 커스텀 필드 추출 후 제거 */
    const logId   = raw._logId  || null;
    const region  = raw._region || '서울';
    const { _logId, _region, ...anthropicBody } = raw;

    /* max_tokens 강제 설정 */
    anthropicBody.max_tokens = 8000;

    /* Anthropic 필수 필드 검증 */
    if (!anthropicBody.model || !anthropicBody.messages) {
      return res.status(400).json({ error: 'model과 messages는 필수입니다' });
    }

    /* Supabase 자동 단가 조회 */
    const autoRefs = await getAutoMarketRefs(region);
    if (autoRefs && anthropicBody.system) {
      anthropicBody.system = anthropicBody.system.replace(
        /Market refs per 평[\s\S]*?Category:/,
        `[실측 데이터 기반]\n${autoRefs}\nCategory:`
      );
    }

    /* Anthropic API 호출 */
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    let data;
    try {
      data = await response.json();
    } catch(e) {
      return res.status(500).json({ error: 'Anthropic 응답 파싱 실패' });
    }

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return res.status(response.status).json({ error: data?.error?.message || JSON.stringify(data) });
    }

    /* Supabase DB 업데이트 */
    if (logId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const rawText = (data.content || []).map(b => b.text || '').join('');
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          await supabase.from('estimate_logs')
            .update({ analysis_result: JSON.parse(match[0]) })
            .eq('id', logId);
        }
      } catch(dbErr) {
        console.error('DB update error:', dbErr.message);
      }
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('analyze error:', err);
    return res.status(500).json({ error: err.message });
  }
}
