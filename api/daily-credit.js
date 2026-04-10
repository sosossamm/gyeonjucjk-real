// api/daily-credit.js — 일일 한정 할인 크레딧 API
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.method === 'GET' ? 'status' : 'purchase');

  try {
    // ── 상태 조회 ──
    if (action === 'status') {
      const { data, error } = await supabase.rpc('get_daily_credit_status');
      if (error) throw error;
      const row = data?.[0] || data;
      return res.status(200).json({
        success: true,
        soldToday: row.sold_today,
        dailyLimit: row.daily_limit,
        remaining: row.remaining,
        isSaleActive: row.is_sale_active,
        salePrice: row.sale_price,
        normalPrice: row.normal_price,
        currentPrice: row.is_sale_active ? row.sale_price : row.normal_price
      });
    }

    // ── 구매 (카운터 증가) ──
    if (action === 'purchase') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const qty = parseInt(req.body?.qty) || 1;
      const { data, error } = await supabase.rpc('increment_daily_sold', { qty });
      if (error) throw error;
      const row = data?.[0] || data;
      return res.status(200).json({
        success: true,
        isSale: row.is_sale,
        unitPrice: row.unit_price,
        totalPrice: row.unit_price * qty,
        newSold: row.new_sold,
        dailyLimit: row.daily_limit
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Daily credit API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
