export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(supabase, token) {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const action = req.query.action;

  try {
    const supabase = await getSupabase();
    const user = await getUser(supabase, token);
    if (!user) return res.status(401).json({ error: '로그인이 필요해요' });

    /* ── 잔액 조회 ── */
    if (action === 'balance') {
      const { data, error } = await supabase
        .from('users')
        .select('credits')
        .eq('id', user.id)
        .single();

      if (error) {
        /* users 레코드 없으면 생성 */
        await supabase.from('users').upsert({
          id: user.id,
          email: user.email,
          name: user.user_metadata?.name || '',
          credits: 0,
          created_at: new Date().toISOString()
        });
        return res.status(200).json({ credits: 0 });
      }
      return res.status(200).json({ credits: data?.credits || 0 });
    }

    /* ── 크레딧 사용 ── */
    if (action === 'use' && req.method === 'POST') {
      const { description = '상세 분석 열람' } = req.body || {};

      /* 현재 잔액 확인 */
      const { data: userData } = await supabase
        .from('users').select('credits').eq('id', user.id).single();

      const currentCredits = userData?.credits || 0;
      if (currentCredits < 1) {
        return res.status(400).json({ error: '크레딧이 부족해요' });
      }

      /* 차감 */
      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({ credits: currentCredits - 1 })
        .eq('id', user.id)
        .select('credits')
        .single();

      if (updateErr) throw updateErr;

      /* 사용 내역 기록 */
      await supabase.from('credit_logs').insert({
        user_id: user.id,
        amount: -1,
        type: 'use',
        description,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true, credits: updated.credits });
    }

    /* ── 크레딧 지급 (보상/충전) ── */
    if (action === 'reward' && req.method === 'POST') {
      const { amount = 1, type = 'reward', description = '공유 보상' } = req.body || {};

      const { data: userData } = await supabase
        .from('users').select('credits').eq('id', user.id).single();

      const currentCredits = userData?.credits || 0;

      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({ credits: currentCredits + amount })
        .eq('id', user.id)
        .select('credits')
        .single();

      if (updateErr) throw updateErr;

      await supabase.from('credit_logs').insert({
        user_id: user.id,
        amount: amount,
        type,
        description,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true, credits: updated.credits });
    }

    /* ── 공유자 크레딧 보상 (서버사이드 — 다른 유저에게 지급) ── */
    if (action === 'rewardSharer' && req.method === 'POST') {
      const { sharerId, shareId, description = '공유 보상' } = req.body || {};
      if (!sharerId) return res.status(400).json({ error: 'sharerId 필요' });

      /* 중복 보상 방지 — 같은 shareId로 이미 보상했는지 확인 */
      const { data: existing } = await supabase
        .from('credit_logs')
        .select('id')
        .eq('user_id', sharerId)
        .eq('type', 'reward')
        .eq('description', `share:${shareId}`)
        .single();

      if (existing) return res.status(200).json({ success: true, message: '이미 지급됨' });

      /* 공유자 크레딧 +1 */
      const { data: sharerData } = await supabase
        .from('users').select('credits').eq('id', sharerId).single();
      const sharerCredits = sharerData?.credits || 0;

      await supabase.from('users')
        .update({ credits: sharerCredits + 1 })
        .eq('id', sharerId);

      await supabase.from('credit_logs').insert({
        user_id: sharerId,
        amount: 1,
        type: 'reward',
        description: `share:${shareId}`,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true });
    }

    /* ── 크레딧 내역 조회 ── */
    if (action === 'history') {
      const { data, error } = await supabase
        .from('credit_logs')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return res.status(200).json({ logs: data || [] });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });

  } catch (err) {
    console.error('credits error:', err);
    return res.status(500).json({ error: err.message });
  }
}
