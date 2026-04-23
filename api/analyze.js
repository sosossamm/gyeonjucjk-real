export const config = { api: { bodyParser: true } };

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

    /* ✅ Anthropic API 먼저 호출 */
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

    /* ✅ 분석 성공 시에만 DB에 저장 */
    let logId = null;
    try {
      const rawText = (data.content || []).map(b => b.text || '').join('');
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);

        /* items가 있고 totalAmount가 있을 때만 저장 */
        if (parsed.items?.length > 0 && parsed.totalAmount) {
          const dbPayload = {
            file_path:       null,
            file_type:       _meta?.fileType || 'unknown',
            region:          _region || null,
            area_py:         _meta?.areaPy || null,
            total_amount:    parsed.totalAmount,
            user_ip:         ip,
            user_id:         _meta?.userId || null,
            analysis_result: parsed,
            created_at:      new Date().toISOString(),
          };
          logId = await saveToSupabase(dbPayload);
        }
      }
    } catch (parseErr) {
      console.error('Result parse/save error:', parseErr.message);
    }

    return res.status(200).json({ ...data, _logId: logId || null });

  } catch (err) {
    console.error('analyze handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
