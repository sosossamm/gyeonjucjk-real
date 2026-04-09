// api/acquisition.js — 사용자 유입 경로 추적 API
// Supabase에 user_acquisitions 테이블로 저장

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

    const { data, error } = await supabase
      .from('user_acquisitions')
      .insert({
        user_id: user_id,
        signup_method: signup_method || 'unknown',
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
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Acquisition API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
