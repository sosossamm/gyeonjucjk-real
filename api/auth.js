export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const supabase = await getSupabase();

    /* ── 이메일 회원가입 ── */
    if (action === 'signup') {
      const { email, password, name } = req.body;
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const { data, error } = await supabase.auth.admin.createUser({
        email, password,
        email_confirm: true,
        user_metadata: { name: name || '' }
      });
      if (error) return res.status(400).json({ error: error.message });

      /* users 테이블에 프로필 저장 */
      await supabase.from('users').upsert({
        id: data.user.id,
        email: data.user.email,
        name: name || '',
        created_at: new Date().toISOString()
      });

      /* 세션 생성 */
      const { data: session, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) return res.status(400).json({ error: signInError.message });

      return res.status(200).json({
        success: true,
        user: { id: data.user.id, email: data.user.email, name },
        access_token: session.session.access_token,
        refresh_token: session.session.refresh_token
      });
    }

    /* ── 이메일 로그인 ── */
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(400).json({ error: '이메일 또는 비밀번호가 틀렸어요' });

      return res.status(200).json({
        success: true,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.user_metadata?.name || ''
        },
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
    }

    /* ── 소셜 로그인 URL 생성 (Google/Kakao) ── */
    if (action === 'oauth') {
      const { provider, redirect_to } = req.body;
      if (!['google', 'kakao'].includes(provider)) {
        return res.status(400).json({ error: '지원하지 않는 로그인 방식이에요' });
      }

      /* Supabase 클라이언트 SDK용 — 프론트에서 직접 처리 */
      return res.status(200).json({
        success: true,
        provider,
        redirect_to: redirect_to || process.env.SITE_URL || 'https://gyeonjucjk-real.vercel.app'
      });
    }

    /* ── 토큰으로 유저 정보 확인 ── */
    if (action === 'me') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: '로그인이 필요해요' });

      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) return res.status(401).json({ error: '세션이 만료됐어요' });

      return res.status(200).json({
        success: true,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.user_metadata?.name || ''
        }
      });
    }

    /* ── 로그아웃 ── */
    if (action === 'logout') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) await supabase.auth.admin.signOut(token);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청이에요' });

  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ error: err.message });
  }
}
