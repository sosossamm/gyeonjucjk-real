export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function hashEmail(email) {
  /* 간단한 해시 — crypto 없이 순수 JS */
  let hash = 0;
  const str = email.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'h' + Math.abs(hash).toString(36);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action: bodyAction, email, password } = req.body || {};
  const action = req.query.action || bodyAction;

  try {
    const supabase = await getSupabase();

    /* ── 회원가입 ── */
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const emailHash = hashEmail(email);

      /* 탈퇴 이력 확인 */
      const { data: deleted } = await supabase
        .from('users')
        .select('deleted_at, email_hash')
        .eq('email_hash', emailHash)
        .not('deleted_at', 'is', null)
        .maybeSingle();

      if (deleted?.deleted_at) {
        const deletedAt = new Date(deleted.deleted_at);
        const canRejoinAt = new Date(deletedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now < canRejoinAt) {
          const daysLeft = Math.ceil((canRejoinAt - now) / (1000 * 60 * 60 * 24));
          return res.status(400).json({
            error: `탈퇴 후 90일이 지나야 재가입할 수 있어요. ${daysLeft}일 후에 가입 가능해요.`
          });
        }
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return res.status(400).json({ error: error.message });

      /* users 테이블에 레코드 생성 */
      if (data.user) {
        await supabase.from('users').upsert({
          id: data.user.id,
          email: data.user.email,
          email_hash: emailHash,
          credits: 0,
          created_at: new Date().toISOString()
        });
      }

      /* 이메일 인증 필요 — session이 null이면 인증 대기 상태 */
      const needsVerification = !data.session;
      return res.status(200).json({
        success: true,
        user: data.user,
        session: data.session || null,
        needsVerification
      });
    }

    /* ── 로그인 ── */
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(400).json({ error: '이메일 또는 비밀번호가 올바르지 않아요' });

      /* ⭐ 추가: users 테이블에서 사용자 존재 여부 확인 */
      if (data.user) {
        const { data: userRecord, error: dbError } = await supabase
          .from('users')
          .select('id, deleted_at')
          .eq('id', data.user.id)
          .maybeSingle();

        /* 사용자가 DB에 없거나 탈퇴한 상태 */
        if (!userRecord || userRecord.deleted_at) {
          return res.status(401).json({ 
            error: '더 이상 사용할 수 없는 계정이에요. 새로 가입해주세요.',
            needsNewSignup: true 
          });
        }
      }

      return res.status(200).json({
        success: true,
        user: data.user,
        access_token: data.session?.access_token,
        session: data.session
      });
    }

    /* ── 회원탈퇴 ── */
    if (action === 'withdraw') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: '로그인이 필요해요' });

      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: '세션이 만료됐어요' });

      const emailHash = hashEmail(user.email);

      /* users 테이블에 탈퇴 처리 (소프트 삭제) */
      const { error: updateErr } = await supabase
        .from('users')
        .upsert({
          id: user.id,
          email: user.email,
          email_hash: emailHash,
          deleted_at: new Date().toISOString(),
          credits: 0
        });

      if (updateErr) console.error('users 탈퇴 처리 오류:', updateErr.message);

      /* auth.users에서 실제 삭제 — service_role로만 가능 */
      const { error: deleteErr } = await supabase.auth.admin.deleteUser(user.id);
      if (deleteErr) {
        console.error('auth 삭제 오류:', deleteErr.message);
        return res.status(500).json({ error: '탈퇴 처리 중 오류가 발생했어요' });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });

  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ error: err.message });
  }
}
