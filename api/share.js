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
      const { analysisResult, logId } = req.body || {};
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
      const baseUrl = req.headers.origin || 'https://gyeonjucjk-real.vercel.app';
      const shareId = genId(8);

      let targetLogId = null;

      if (logId) {
        /* 마이페이지에서 기존 log_id로 공유 */
        targetLogId = logId;
      } else if (analysisResult) {
        /* 결과 화면에서 analysisResult 직접 전달 */
        const { data: log, error: logErr } = await supabase
          .from('estimate_logs')
          .insert({
            file_type: 'share',
            region: analysisResult.region || null,
            area_py: null,
            total_amount: analysisResult.totalAmount || null,
            user_ip: ip,
            analysis_result: analysisResult,
            created_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (logErr) throw logErr;
        targetLogId = log.id;
      } else {
        return res.status(400).json({ error: '분석 결과 없음' });
      }

      /* share_links 레코드 삽입 */
      /* 공유자 ID 추출 */
      const sharerId = req.headers.authorization
        ? await (async () => {
            try {
              const tok = req.headers.authorization.replace('Bearer ', '');
              const { data: { user } } = await supabase.auth.getUser(tok);
              return user?.id || null;
            } catch(e) { return null; }
          })()
        : null;

      const { error: shareErr } = await supabase
        .from('share_links')
        .insert({ id: shareId, log_id: targetLogId, sharer_id: sharerId });
      if (shareErr) throw shareErr;

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

      const { data: link, error: linkErr } = await supabase
        .from('share_links')
        .select('id, log_id, view_count, created_at, sharer_id')
        .eq('id', shareId)
        .single();

      if (linkErr || !link) return res.status(404).json({ error: '링크를 찾을 수 없어요' });

      /* 조회수 업데이트 */
      supabase.from('share_links')
        .update({ view_count: (link.view_count || 0) + 1 })
        .eq('id', shareId)
        .then(() => {});

      const { data: log, error: logErr } = await supabase
        .from('estimate_logs')
        .select('analysis_result, total_amount, region, created_at')
        .eq('id', link.log_id)
        .single();

      if (logErr || !log) return res.status(404).json({ error: '분석 결과를 찾을 수 없어요' });

      const result = log.analysis_result || {};
      const safeResult = {
        totalAmount:    result.totalAmount || log.total_amount,
        overallVerdict: result.overallVerdict,
        overallComment: result.overallComment,
        itemCount:      (result.items || []).length,
        expCount:       (result.items || []).filter(i => i.verdict === '비쌈').length,
        fairCount:      (result.items || []).filter(i => i.verdict === '적정').length,
        cheapCount:     (result.items || []).filter(i => i.verdict === '저렴').length,
        region:         log.region,
        createdAt:      log.created_at,
        viewCount:      (link.view_count || 0) + 1,
        sharerId:       link.sharer_id || null,
        allItems:       (result.items || []).map(i => ({
          name: i.name, category: i.category, verdict: i.verdict, amount: i.amount,
        })),
        previewItems:   (result.items || []).slice(0, 2).map(i => ({
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
