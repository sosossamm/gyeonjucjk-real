import { createClient } from '@supabase/supabase-js';

/* ── 공정별 단가 자동 집계 ── */
async function getAutoMarketRefs(region) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return null; // 환경변수 없으면 기본 단가 사용
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: logs, error } = await supabase
      .from('estimate_logs')
      .select('region, area_py, analysis_result')
      .not('analysis_result', 'is', null)
      .limit(2000);

    if (error || !logs || logs.length < 30) return null; // 데이터 부족

    // 공정명 → 카테고리 매핑
    const CAT_MAP = {
      '철거': '철거/방수', '방수': '철거/방수',
      '창호': '창호/샷시', '샷시': '창호/샷시', '새시': '창호/샷시',
      '확장': '확장/설비', '설비': '확장/설비', '보일러': '확장/설비',
      '목공': '목공', '우물천장': '목공', '가벽': '목공',
      '바닥': '바닥재', '마루': '바닥재', '장판': '바닥재',
      '도배': '도배',
      '도장': '도장', '페인트': '도장',
      '타일': '타일',
      '욕실': '욕실', '화장실': '욕실',
      '주방': '주방', '싱크대': '주방',
      '붙박이': '가구/붙박이장', '가구': '가구/붙박이장', '드레스룸': '가구/붙박이장',
      '전기': '조명/전기', '조명': '조명/전기',
      '기업이윤': '기업이윤', '이윤': '기업이윤',
    };

    function getCategory(name) {
      if (!name) return null;
      for (const [key, cat] of Object.entries(CAT_MAP)) {
        if (name.includes(key)) return cat;
      }
      return null;
    }

    function normalizeToPerPy(cat, amount, area_py) {
      if (!area_py || area_py === 0) return null;
      const perPy = ['바닥재','도배','도장','목공','조명/전기','철거/방수'];
      const perM2 = ['타일'];
      if (perPy.includes(cat)) return Math.round(amount / area_py * 10) / 10;
      if (perM2.includes(cat)) return Math.round(amount / (area_py * 3.3) * 10) / 10;
      return amount; // 욕실/주방/가구 등은 개소 단위 그대로
    }

    // 지역 정규화
    function normalizeRegion(r) {
      if (!r) return null;
      if (r.includes('서울')) return '서울';
      if (r.includes('수도권') || r.includes('경기') || r.includes('인천')) return '수도권';
      if (['부산','대구','광주','대전','울산','세종'].some(c => r.includes(c))) return '광역시';
      return '기타';
    }

    // 공정별 · 지역별 데이터 수집
    const buckets = {};
    for (const log of logs) {
      const regionKey = normalizeRegion(log.region);
      if (!regionKey || regionKey === '기타') continue;
      const items = log.analysis_result?.items || [];
      for (const item of items) {
        const cat = getCategory(item.name) || getCategory(item.category);
        if (!cat || !item.amount) continue;
        const norm = normalizeToPerPy(cat, item.amount, log.area_py);
        if (!norm || norm <= 0 || norm > 10000) continue; // 이상치 제외
        if (!buckets[cat]) buckets[cat] = { 서울: [], 수도권: [], 광역시: [] };
        if (buckets[cat][regionKey]) buckets[cat][regionKey].push(norm);
      }
    }

    // 공정별 통계 (IQR 이상치 제거)
    const stats = {};
    const MIN_SAMPLE = 20; // 최소 샘플 수
    for (const [cat, regions] of Object.entries(buckets)) {
      stats[cat] = {};
      for (const [rg, values] of Object.entries(regions)) {
        if (values.length < MIN_SAMPLE) continue;
        const sorted = [...values].sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        const filtered = sorted.filter(v => v >= q1 - 1.5*iqr && v <= q3 + 1.5*iqr);
        stats[cat][rg] = {
          min: Math.round(filtered[0]),
          max: Math.round(filtered[filtered.length - 1]),
          avg: Math.round(filtered.reduce((a,b)=>a+b,0)/filtered.length),
          n: filtered.length
        };
      }
    }

    // 요청 지역 기준 Market refs 문자열 생성
    const targetRegion = region?.includes('서울') ? '서울'
      : region?.includes('수도권') ? '수도권'
      : region?.includes('광역시') ? '광역시'
      : '서울';

    const lines = [];
    for (const [cat, regions] of Object.entries(stats)) {
      const s = regions[targetRegion] || regions['서울'];
      if (s) {
        lines.push(`· ${cat} ${targetRegion}기준 ${s.min}~${s.max}만 (평균${s.avg}만, n=${s.n})`);
      }
    }

    if (lines.length < 3) return null; // 데이터 부족하면 기본 단가 사용

    return lines.join('\n');

  } catch (err) {
    console.error('pricing error:', err.message);
    return null;
  }
}

/* ── 기본 Market refs (Supabase 데이터 부족 시 사용) ── */
const DEFAULT_MARKET_REFS = `Market refs per 평:
· 철거 평당15~25만 · 방수(발코니) m2당8~15만
· 욕실타일 개소당100~200만 · 주방벽타일 m2당6~12만 · 거실타일 m2당6~14만
· 강마루 m2당4~8만 · 원목마루 m2당8~15만 · 장판 m2당2~4만
· 도배(실크) 평당3~5만 · 도배(합지) 평당2~3만
· 도장 m2당2~4만
· 욕실리모델링 개소당250~600만 · 양변기 30~80만 · 세면대 20~60만
· 싱크대상부장 m당30~80만 · 싱크대하부장 m당40~100만 · 싱크대상판 m당20~50만
· 붙박이장 90cm폭당60~150만 · 드레스룸 200~600만/식
· 전기배선 평당10~20만 · 조명교체 평당3~7만 · 간접조명박스 평당4~9만
· 발코니새시 150~400만/식 · 현관문 80~200만
· 목공(몰딩·걸레받이) 평당5~11만 · 목공(무몰딩) 평당9~22만
· 목공(우물천장) m2당10~22만 · 목공(가벽) m2당10~22만 · 히든도어 짝당80~200만
· 보일러 50~150만/식 · 발코니확장 평당150~350만`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const logId = body._logId;
    const region = body._region || '서울';
    delete body._logId;
    delete body._region;
    body.max_tokens = 8000;

    /* Supabase에서 최신 단가 자동 조회 */
    const autoRefs = await getAutoMarketRefs(region);
    const marketRefs = autoRefs
      ? `[실측 데이터 기반 단가 — Supabase 자동 집계]\n${autoRefs}`
      : `[기본 단가 기준]\n${DEFAULT_MARKET_REFS}`;

    /* system prompt의 Market refs를 동적으로 교체 */
    if (body.system) {
      body.system = body.system.replace(
        /Market refs per 평[\s\S]*?Category:/,
        `${marketRefs}\nCategory:`
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
      body: JSON.stringify(body),
    });

    const data = await response.json();

    /* 분석 결과 Supabase에 저장 */
    if (logId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );
        const rawText = (data.content || []).map(b => b.text || '').join('');
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          await supabase
            .from('estimate_logs')
            .update({ analysis_result: JSON.parse(match[0]) })
            .eq('id', logId);
        }
      } catch (dbErr) {
        console.error('DB update error:', dbErr.message);
      }
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
