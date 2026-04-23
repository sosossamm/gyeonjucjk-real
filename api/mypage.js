export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '로그인이 필요해요' });

  try {
    const supabase = await getSupabase();

    /* 토큰으로 유저 확인 */
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: '세션이 만료됐어요' });

    const action = req.query.action || 'history';

    /* ── 분석 기록 조회 ── */
    if (action === 'history') {
      const { data: logs, error } = await supabase
        .from('estimate_logs')
        .select('id, region, area_py, total_amount, created_at, analysis_result, file_type')
        .eq('user_id', user.id)
        .neq('file_type', 'share')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      /* ✅ 열람 기록을 먼저 조회 — history 매핑에서 참조하기 때문 */
      let unlockedIds = new Set();
      try {
        const { data: unlocked } = await supabase
          .from('unlocked_logs')
          .select('log_id')
          .eq('user_id', user.id);
        (unlocked || []).forEach(u => unlockedIds.add(String(u.log_id)));
      } catch(e) {}

      /* ✅ unlockedIds 준비 후 매핑 */
      const history = (logs || []).map(log => {
        const r = log.analysis_result || {};
        const items = r.items || [];
        return {
          id: log.id,
          region: log.region,
          area_py: log.area_py,
          total_amount: log.total_amount || r.totalAmount,
          created_at: log.created_at,
          verdict: r.overallVerdict || '적정',
          comment: r.overallComment || '',
          item_count: items.length,
          exp_count: items.filter(i => i.verdict === '비쌈').length,
          fair_count: items.filter(i => i.verdict === '적정').length,
          cheap_count: items.filter(i => i.verdict === '저렴').length,
          has_result: !!log.analysis_result,
          is_unlocked: unlockedIds.has(String(log.id)),
        };
      });

      /* 통계 */
      const stats = {
        total: history.length,
        exp_count: history.filter(h => h.verdict === '비쌈').length,
        share_count: 0,
      };

      /* share_links 조회 시도 */
      try {
        const { count } = await supabase
          .from('share_links')
          .select('id', { count: 'exact', head: true })
          .in('log_id', history.map(h => h.id));
        stats.share_count = count || 0;
      } catch(e) {}

      return res.status(200).json({ success: true, history, stats, user: { id: user.id, email: user.email, name: user.user_metadata?.name || '' } });
    }

    /* ── 분석 결과 단건 조회 ── */
    if (action === 'detail') {
      const logId = req.query.id;
      if (!logId) return res.status(400).json({ error: 'id 필요' });

      const { data: log, error } = await supabase
        .from('estimate_logs')
        .select('*')
        .eq('id', logId)
        .eq('user_id', user.id)
        .single();

      if (error || !log) return res.status(404).json({ error: '기록을 찾을 수 없어요' });
      return res.status(200).json({ success: true, result: log.analysis_result });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });

  } catch (err) {
    console.error('mypage error:', err);
    return res.status(500).json({ error: err.message });
  }
}
