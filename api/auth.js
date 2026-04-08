export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function hashEmail(email) {
  let hash = 0;
  const str = email.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'h' + Math.abs(hash).toString(36);
}

/* ── Brevo 이메일 발송 ── */
async function sendVerificationEmail(email, verificationUrl) {
  const brevoApiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL || 'noreply@quote-analysis.site';
  const fromName = '견적분석';

  if (!brevoApiKey) {
    console.warn('⚠️ BREVO_API_KEY not set');
    return true;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'api-key': brevoApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: email, name: email.split('@')[0] }],
        subject: '견적분석 이메일 인증',
        htmlContent: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background: #0F0E0C; color: #fff; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 20px;"><h1 style="margin: 0; font-size: 24px;">이메일 인증</h1></div><div style="padding: 20px; background: #F8F6F2; border-radius: 8px; border: 1px solid #E8E5E0;"><p style="margin: 0 0 20px; color: #0F0E0C; font-size: 16px;"><strong>${email}</strong>님 안녕하세요!</p><p style="margin: 0 0 20px; color: #4A4743; line-height: 1.6;">견적분석 가입을 완료하기 위해 아래 버튼을 클릭해주세요.</p><div style="margin: 30px 0; text-align: center;"><a href="${verificationUrl}" style="display: inline-block; background: #1F4FD8; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px;">이메일 인증하기</a></div><p style="margin: 20px 0 0; color: #8A8780; font-size: 12px;">이 링크는 24시간 동안 유효합니다.</p></div></div>`,
        replyTo: { email: fromEmail, name: fromName }
      })
    });

    const result = await response.json();
    console.log('✅ Brevo 이메일 발송:', email);
    return response.ok;
  } catch (err) {
    console.error('❌ Brevo 오류:', err.message);
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action: bodyAction, email, password, newPassword } = req.body || {};
  const action = req.query.action || bodyAction;

  try {
    const supabase = await getSupabase();

    /* ── 회원가입 ── */
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const emailHash = hashEmail(email);
      const { data: deleted } = await supabase.from('users').select('deleted_at').eq('email_hash', emailHash).not('deleted_at', 'is', null).maybeSingle();

      if (deleted?.deleted_at) {
        const deletedAt = new Date(deleted.deleted_at);
        const canRejoinAt = new Date(deletedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (now < canRejoinAt) {
          const daysLeft = Math.ceil((canRejoinAt - now) / (1000 * 60 * 60 * 24));
          return res.status(400).json({ error: `탈퇴 후 ${daysLeft}일 후에 가입 가능해요.` });
        }
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return res.status(400).json({ error: error.message });

      if (data.user) {
        await supabase.from('users').upsert({
          id: data.user.id,
          email: data.user.email,
          email_hash: emailHash,
          credits: 0,
          created_at: new Date().toISOString()
        });

        const verificationUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/?verify=${data.user.id}&email=${encodeURIComponent(email)}`;
        await sendVerificationEmail(email, verificationUrl);
      }

      return res.status(200).json({ success: true, user: data.user, session: data.session || null, needsVerification: true });
    }

    /* ── 로그인 ── */
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(400).json({ error: '이메일 또는 비밀번호가 올바르지 않아요' });

      if (data.user) {
        const { data: userRecord } = await supabase.from('users').select('id, deleted_at, email_confirmed_at').eq('id', data.user.id).maybeSingle();

        if (!userRecord || userRecord.deleted_at) {
          return res.status(401).json({ error: '더 이상 사용할 수 없는 계정이에요.', needsNewSignup: true });
        }

        if (!userRecord.email_confirmed_at) {
          return res.status(401).json({ error: '이메일 인증이 필요해요.', needsEmailVerification: true, email: email });
        }
      }

      return res.status(200).json({ success: true, user: data.user, access_token: data.session?.access_token, session: data.session });
    }

    /* ── 비밀번호 재설정 요청 ── */
    if (action === 'resetPassword') {
      if (!email) return res.status(400).json({ error: '이메일을 입력해주세요' });

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/reset-password`
        });

        if (error) {
          console.error('비밀번호 재설정 오류:', error.message);
          return res.status(200).json({ success: true, message: '이메일이 등록되어 있다면 재설정 링크를 보냈습니다.' });
        }

        return res.status(200).json({ success: true, message: '비밀번호 재설정 링크를 이메일로 보냈습니다.' });
      } catch (err) {
        console.error('비밀번호 재설정 오류:', err.message);
        return res.status(200).json({ success: true, message: '이메일이 등록되어 있다면 재설정 링크를 보냈습니다.' });
      }
    }

    /* ── 비밀번호 업데이트 ── */
    if (action === 'updatePassword') {
      const token = req.headers.authorization?.replace('Bearer ', '');

      if (!token) return res.status(401).json({ error: '로그인이 필요해요' });
      if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 해요' });

      try {
        const { error } = await supabase.auth.updateUser({ password: newPassword }, { authorization: `Bearer ${token}` });

        if (error) return res.status(400).json({ error: error.message });

        return res.status(200).json({ success: true, message: '비밀번호가 변경되었습니다.' });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    /* ── 회원탈퇴 ── */
    if (action === 'withdraw') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: '로그인이 필요해요' });

      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: '세션이 만료됐어요' });

      const emailHash = hashEmail(user.email);

      await supabase.from('users').upsert({
        id: user.id,
        email: user.email,
        email_hash: emailHash,
        deleted_at: new Date().toISOString(),
        credits: 0
      });

      const { error: deleteErr } = await supabase.auth.admin.deleteUser(user.id);
      if (deleteErr) return res.status(500).json({ error: '탈퇴 처리 중 오류가 발생했어요' });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
