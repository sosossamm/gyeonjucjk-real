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
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://quote-analysis.site';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = await getSupabase();
  if (!supabase) return res.status(500).json({ error: 'DB 연결 실패' });

  /* ── POST: 공유 링크 생성 ── */
  if (req.method === 'POST') {
    try {
      const { analysisResult, logId, referrerId } = req.body || {};

      // analysisResult 크기 제한
      if (analysisResult) {
        const size = JSON.stringify(analysisResult).length;
        if (size > 500_000) return res.status(400).json({ error: '분석 결과 데이터가 너무 큽니다.' });
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
      const baseUrl = process.env.ALLOWED_ORIGIN || 'https://quote-analysis.site';
      const shareId = genId(8);

      let targetLogId = null;

      if (logId) {
        targetLogId = logId;
      } else if (analysisResult) {
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

      /* 공유자 ID 추출 (Authorization 헤더 또는 body의 referrerId) */
      let sharerId = referrerId || null;
      if (!sharerId && req.headers.authorization) {
        try {
          const tok = req.headers.authorization.replace('Bearer ', '');
          const { data: { user } } = await supabase.auth.getUser(tok);
          sharerId = user?.id || null;
        } catch(e) {}
      }

      const { error: shareErr } = await supabase
        .from('share_links')
        .insert({ id: shareId, log_id: targetLogId, sharer_id: sharerId });
      if (shareErr) throw shareErr;

      return res.status(200).json({ shareId, url: `${baseUrl}/share/${shareId}` });

    } catch (err) {
      console.error('share create error:', err);
      return res.status(500).json({ error: '공유 링크 생성에 실패했어요. 다시 시도해주세요.' });
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

      /* 조회수 비동기 업데이트 */
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

      /* analysisResult 전체 반환 — 프론트 render() 함수가 필요로 하는 전체 구조 */
      const analysisResult = log.analysis_result || {};

      /* totalAmount 보완 */
      if (!analysisResult.totalAmount && log.total_amount) {
        analysisResult.totalAmount = log.total_amount;
      }

      const items = (analysisResult.items || []).filter(i => i.amount && i.amount > 0);

      /* share_page_v4.html 호환용 data 구조 */
      const safeData = {
        totalAmount:    analysisResult.totalAmount || log.total_amount,
        overallVerdict: analysisResult.overallVerdict,
        overallComment: analysisResult.overallComment,
        itemCount:      items.length,
        expCount:       items.filter(i => i.verdict === '비쌈').length,
        fairCount:      items.filter(i => i.verdict === '적정').length,
        cheapCount:     items.filter(i => i.verdict === '저렴').length,
        region:         log.region,
        createdAt:      log.created_at,
        viewCount:      (link.view_count || 0) + 1,
        sharerId:       link.sharer_id || null,
        allItems:       items.map(i => ({
          name: i.name, category: i.category, verdict: i.verdict, amount: i.amount,
        })),
      };

      return res.status(200).json({
        success: true,
        analysisResult,   /* index.html의 render()용 전체 구조 */
        data: safeData,   /* share_page_v4.html 호환용 */
        sharerId: link.sharer_id || null,
        viewCount: (link.view_count || 0) + 1,
        shareId,
      });

    } catch (err) {
      console.error('share get error:', err);
      return res.status(500).json({ error: '공유 링크 조회에 실패했어요.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
