// api/daily-credit.js — 일일 한정 할인 크레딧 API
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://quote-analysis.site';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.method === 'GET' ? 'status' : 'purchase');

  try {
    // ── 상태 조회 (인증 불필요 — 배너 표시용) ──
    if (action === 'status') {
      const { data, error } = await supabase.rpc('get_daily_credit_status');
      if (error) throw error;
      const row = data?.[0] || data;
      return res.status(200).json({
        success: true,
        soldToday:   row.sold_today,
        dailyLimit:  row.daily_limit,
        remaining:   row.remaining,
        isSaleActive: row.is_sale_active,
        salePrice:   row.sale_price,
        normalPrice: row.normal_price,
        currentPrice: row.is_sale_active ? row.sale_price : row.normal_price
      });
    }

    // ── 카운터 증가 — 서버 내부(credits API)에서만 호출 ──
    // 외부에서 직접 호출 시 서버 시크릿으로 검증
    if (action === 'purchase') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      // 내부 서버 호출 검증 — INTERNAL_SECRET이 일치해야만 허용
      const internalSecret = process.env.INTERNAL_API_SECRET;
      const reqSecret = req.headers['x-internal-secret'];
      if (internalSecret && reqSecret !== internalSecret) {
        return res.status(403).json({ error: '직접 호출이 허용되지 않습니다.' });
      }

      const qty = parseInt(req.body?.qty) || 1;
      if (qty < 1 || qty > 10) return res.status(400).json({ error: '잘못된 수량' });

      const { data, error } = await supabase.rpc('increment_daily_sold', { qty });
      if (error) throw error;
      const row = data?.[0] || data;
      return res.status(200).json({
        success: true,
        isSale:     row.is_sale,
        unitPrice:  row.unit_price,
        totalPrice: row.unit_price * qty,
        newSold:    row.new_sold,
        dailyLimit: row.daily_limit
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Daily credit API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
