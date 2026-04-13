// api/acquisition.js — 사용자 유입 경로 추적 + 추천인 크레딧 지급 API

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role 키 (서버 전용)
);

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      user_id,
      signup_method,
      ref,           // 추천인 userId (공유 링크의 ?ref=xxx)
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
      gclid,
      fbclid,
      referrer,
      landing_url,
      landed_at
    } = req.body || {};

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // ── 1. 유입 경로 저장 ──────────────────────────────────────────
    const { error: acqError } = await supabase
      .from('user_acquisitions')
      .insert({
        user_id,
        signup_method: signup_method || 'unknown',
        ref: ref || null,              // 추천인 ID도 함께 저장
        utm_source: utm_source || 'direct',
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        utm_term: utm_term || null,
        utm_content: utm_content || null,
        gclid: gclid || null,
        fbclid: fbclid || null,
        referrer: referrer || null,
        landing_url: landing_url || '/',
        landed_at: landed_at || new Date().toISOString(),
        created_at: new Date().toISOString()
      });

    if (acqError) {
      console.error('Supabase insert error:', acqError);
      return res.status(500).json({ error: acqError.message });
    }

    // ── 2. 추천인 크레딧 지급 ─────────────────────────────────────
    if (ref && ref !== user_id) {  // ref 있고, 자기 자신 추천이 아닐 때

      // 중복 지급 방지 — 같은 추천 건으로 이미 지급했는지 확인
      const { data: alreadyRewarded } = await supabase
        .from('credit_logs')
        .select('id')
        .eq('user_id', ref)
        .eq('type', 'reward')
        .eq('description', `referral:${user_id}`)
        .maybeSingle();

      if (!alreadyRewarded) {
        // 추천인 현재 크레딧 조회
        const { data: creditRow } = await supabase
          .from('user_credits')
          .select('credits')
          .eq('user_id', ref)
          .maybeSingle();

        const currentCredits = creditRow?.credits ?? 0;

        // 크레딧 +1 업서트
        const { error: creditError } = await supabase
          .from('user_credits')
          .upsert(
            { user_id: ref, credits: currentCredits + 1 },
            { onConflict: 'user_id' }
          );

        if (creditError) {
          console.error('크레딧 지급 오류:', creditError);
          // 크레딧 지급 실패해도 유입 추적은 성공 처리
        } else {
          // 지급 로그 기록
          await supabase.from('credit_logs').insert({
            user_id: ref,
            amount: 1,
            type: 'reward',
            description: `referral:${user_id}`,  // 중복 방지 키
            created_at: new Date().toISOString()
          });

          console.log(`추천 크레딧 지급 완료 — 추천인: ${ref}, 신규가입: ${user_id}`);
        }
      } else {
        console.log(`추천 크레딧 중복 방지 — 이미 지급됨: referral:${user_id}`);
      }
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Acquisition API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
