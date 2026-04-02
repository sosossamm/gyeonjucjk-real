export const config = { api: { bodyParser: true } };

function genId(len = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = await getSupabase();
  if (!supabase) return res.status(500).json({ error: 'DB 연결 실패' });

  /* ── POST: 공유 링크 생성 ── */
  if (req.method === 'POST') {
    try {
      const { analysisResult } = req.body || {};
      if (!analysisResult) return res.status(400).json({ error: '분석 결과 없음' });

      /* log_id 없이 결과 직접 저장 */
      const shareId = genId(8);

      /* estimate_logs에 공유용 레코드 삽입 */
      const { data: log, error: logErr } = await supabase
        .from('estimate_logs')
        .insert({
          file_type: 'share',
          region: analysisResult.region || null,
          area_py: null,
          total_amount: analysisResult.totalAmount || null,
          user_ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
          analysis_result: analysisResult,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (logErr) throw logErr;

      /* share_links 레코드 삽입 */
      const { error: shareErr } = await supabase
        .from('share_links')
        .insert({ id: shareId, log_id: log.id });

      if (shareErr) throw shareErr;

      const baseUrl = req.headers.origin || 'https://gyeonjucjk-real.vercel.app';
      return res.status(200).json({ shareId, url: `${baseUrl}/share/${shareId}` });

    } catch (err) {
      console.error('share create error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  /* ── GET: 공유 링크 조회 ── */
  if (req.method === 'GET') {
    try {
      const shareId = req.query.id;
      if (!shareId) return res.status(400).json({ error: 'id 필요' });

      /* 조회수 증가 + 데이터 가져오기 */
      const { data: link, error: linkErr } = await supabase
        .from('share_links')
        .select('id, log_id, view_count, created_at')
        .eq('id', shareId)
        .single();

      if (linkErr || !link) return res.status(404).json({ error: '링크를 찾을 수 없어요' });

      /* 조회수 업데이트 (비동기, 실패해도 무시) */
      supabase.from('share_links')
        .update({ view_count: (link.view_count || 0) + 1 })
        .eq('id', shareId)
        .then(() => {});

      /* 분석 결과 가져오기 */
      const { data: log, error: logErr } = await supabase
        .from('estimate_logs')
        .select('analysis_result, total_amount, region, created_at')
        .eq('id', link.log_id)
        .single();

      if (logErr || !log) return res.status(404).json({ error: '분석 결과를 찾을 수 없어요' });

      /* 공유용 — 상세 팁은 가림 처리 */
      const result = log.analysis_result || {};
      const safeResult = {
        totalAmount:     result.totalAmount,
        overallVerdict:  result.overallVerdict,
        overallComment:  result.overallComment,
        itemCount:       (result.items || []).length,
        expCount:        (result.items || []).filter(i => i.verdict === '비쌈').length,
        cheapCount:      (result.items || []).filter(i => i.verdict === '저렴').length,
        region:          log.region,
        createdAt:       log.created_at,
        viewCount:       (link.view_count || 0) + 1,
        /* 상세 항목은 블러용으로 2개만 공개 */
        previewItems:    (result.items || []).slice(0, 2).map(i => ({
          name: i.name, category: i.category, verdict: i.verdict, amount: i.amount,
        })),
      };

      return res.status(200).json({ success: true, data: safeResult, shareId });

    } catch (err) {
      console.error('share get error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
