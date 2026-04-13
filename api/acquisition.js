// api/acquisition.js — 사용자 유입 경로 추적만 담당
// 추천 리워드는 프론트 onAuthStateChange → /api/credits?action=rewardSharer 에서 처리

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      user_id, signup_method, ref,
      utm_source, utm_medium, utm_campaign,
      utm_term, utm_content, gclid, fbclid,
      referrer, landing_url, landed_at
    } = req.body || {};

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const { error } = await supabase
      .from('user_acquisitions')
      .insert({
        user_id,
        signup_method: signup_method || 'unknown',
        ref: ref || null,
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

    if (error) {
      console.error('user_acquisitions insert error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Acquisition API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
