/**
 * api/pricing.js
 * Supabase estimate_logs 테이블에서 공정별 단가를 자동 집계해
 * Market refs 프롬프트 문자열을 반환합니다.
 *
 * 사용법:
 *   GET /api/pricing          → 집계 결과 JSON 반환
 *   GET /api/pricing?format=prompt → 프롬프트 문자열 반환
 *
 * Vercel 환경변수 필요: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { createClient } from '@supabase/supabase-js';

/* 공정명 → 카테고리 매핑 */
const CAT_MAP = {
  '철거': '철거/방수', '방수': '철거/방수', '철거/방수': '철거/방수',
  '창호': '창호/샷시', '샷시': '창호/샷시', '새시': '창호/샷시', '창호/샷시': '창호/샷시',
  '확장': '확장/설비', '설비': '확장/설비', '보일러': '확장/설비', '확장/설비': '확장/설비',
  '목공': '목공', '우물천장': '목공', '가벽': '목공', '몰딩': '목공',
  '바닥': '바닥재', '마루': '바닥재', '장판': '바닥재', '바닥재': '바닥재',
  '도배': '도배',
  '도장': '도장', '페인트': '도장',
  '타일': '타일',
  '욕실': '욕실', '화장실': '욕실',
  '주방': '주방', '싱크대': '주방',
  '붙박이': '가구/붙박이장', '가구': '가구/붙박이장', '드레스룸': '가구/붙박이장',
  '전기': '조명/전기', '조명': '조명/전기', '조명/전기': '조명/전기',
  '기업이윤': '기업이윤', '이윤': '기업이윤',
};

/* 단위 정규화 */
function normalizeUnit(cat, amount, area_py) {
  if (!area_py || area_py === 0) return amount;
  const perPyeong = ['바닥재', '도배', '도장', '목공', '조명/전기', '철거/방수'];
  const perM2cats = ['타일'];
  if (perPyeong.includes(cat)) return Math.round(amount / area_py * 10) / 10;
  if (perM2cats.includes(cat)) return Math.round(amount / (area_py * 3.3) * 10) / 10;
  return amount; // 식·개소 단위는 그대로
}

function getCategory(name) {
  if (!name) return null;
  const lname = name.toLowerCase();
  for (const [key, cat] of Object.entries(CAT_MAP)) {
    if (lname.includes(key.toLowerCase())) return cat;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase 환경변수 없음' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    /* analysis_result가 있는 로그만 조회 */
    const { data: logs, error } = await supabase
      .from('estimate_logs')
      .select('region, area_py, analysis_result')
      .not('analysis_result', 'is', null)
      .limit(2000);

    if (error) throw error;

    /* 공정별·지역별 금액 수집 */
    const buckets = {}; // { '철거/방수': { 서울: [amt,...], 수도권: [...], 광역시: [...] } }

    for (const log of logs) {
      const { region, area_py, analysis_result } = log;
      const items = analysis_result?.items || [];
      const regionKey = region?.includes('서울') ? '서울'
        : region?.includes('수도권') || region?.includes('경기') || region?.includes('인천') ? '수도권'
        : region?.includes('광역시') || ['부산','대구','인천','광주','대전','울산'].some(c => region?.includes(c)) ? '광역시'
        : null;

      if (!regionKey) continue;

      for (const item of items) {
        const cat = getCategory(item.name) || getCategory(item.category);
        if (!cat) continue;
        const norm = normalizeUnit(cat, item.amount, area_py);
        if (!norm || norm <= 0) continue;
        if (!buckets[cat]) buckets[cat] = { 서울: [], 수도권: [], 광역시: [] };
        buckets[cat][regionKey].push(norm);
      }
    }

    /* 통계 계산 */
    const stats = {};
    for (const [cat, regions] of Object.entries(buckets)) {
      stats[cat] = {};
      for (const [region, values] of Object.entries(regions)) {
        if (values.length < 5) {
          stats[cat][region] = { count: values.length, sufficient: false };
          continue;
        }
        // IQR 이상치 제거
        const sorted = [...values].sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        const filtered = sorted.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
        const avg = filtered.reduce((a, b) => a + b, 0) / filtered.length;
        const min = Math.round(filtered[0]);
        const max = Math.round(filtered[filtered.length - 1]);
        stats[cat][region] = {
          count: filtered.length,
          avg: Math.round(avg),
          min, max,
          sufficient: filtered.length >= 20
        };
      }
    }

    const format = req.query?.format;

    if (format === 'prompt') {
      /* 프롬프트 문자열 생성 */
      const lines = [];
      for (const [cat, regions] of Object.entries(stats)) {
        const s = regions['서울'];
        if (s?.sufficient) {
          lines.push(`· ${cat} 서울기준 ${s.min}~${s.max}만 (평균${s.avg}만, n=${s.count})`);
        }
      }
      return res.status(200).json({
        generated_at: new Date().toISOString(),
        total_logs: logs.length,
        prompt_string: lines.join('\n') || '데이터 부족 (공정당 20건 이상 필요)',
        stats
      });
    }

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      total_logs: logs.length,
      stats,
      note: '공정당 sufficient:true 인 항목만 프롬프트에 반영하세요. ?format=prompt 로 문자열 자동생성 가능'
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
