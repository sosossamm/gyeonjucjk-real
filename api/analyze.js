export const config = { api: { bodyParser: true } };

/* ── 기본 Market refs ── */
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

/* ── Supabase DB 저장 (동적 import로 에러 격리) ── */
async function saveToSupabase(payload) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('estimate_logs')
      .insert(payload)
      .select('id')
      .single();

    if (error) { console.error('DB insert error:', error.message); return null; }
    return data?.id || null;
  } catch (err) {
    console.error('Supabase error:', err.message);
    return null;
  }
}

async function updateSupabase(id, analysisResult) {
  try {
    if (!id || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('estimate_logs').update({ analysis_result: analysisResult }).eq('id', id);
  } catch (err) {
    console.error('DB update error:', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    /* 커스텀 필드 분리 */
    const { _logId, _region, _meta, ...anthropicBody } = body;
    anthropicBody.max_tokens = 8000;

    if (!anthropicBody.model || !anthropicBody.messages) {
      return res.status(400).json({ error: 'model과 messages는 필수입니다' });
    }

    /* IP 추출 */
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

    /* DB에 분석 요청 로그 먼저 저장 */
    const dbPayload = {
      file_path:    null,
      file_type:    _meta?.fileType || 'unknown',
      region:       _region || null,
      area_py:      _meta?.areaPy || null,
      total_amount: _meta?.totalAmount || null,
      user_ip:      ip,
      user_id:      _meta?.userId || null,
      analysis_result: null,
      created_at:   new Date().toISOString(),
    };
    const logId = await saveToSupabase(dbPayload);

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
    try { data = await response.json(); }
    catch (e) { return res.status(500).json({ error: 'Anthropic 응답 파싱 실패' }); }

    if (!response.ok) {
      const msg = data?.error?.message || JSON.stringify(data?.error || data);
      console.error('Anthropic error:', msg);
      return res.status(response.status).json({ error: msg });
    }

    /* 분석 결과 파싱 후 DB 업데이트 */
    try {
      const rawText = (data.content || []).map(b => b.text || '').join('');
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match && logId) {
        const parsed = JSON.parse(match[0]);
        await updateSupabase(logId, parsed);
      }
    } catch (parseErr) {
      console.error('Result parse error:', parseErr.message);
    }

    return res.status(200).json({ ...data, _logId: logId || null });

  } catch (err) {
    console.error('analyze handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
