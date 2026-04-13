export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const DAILY_LIMIT = 100;
const SALE_PRICE = 10000;
const NORMAL_PRICE = 20000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    const supabase = await getSupabase();

    /* ── 할인 상태 조회 ── */
    if (action === 'status') {
      /* 오늘 날짜 (KST 기준) */
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const today = kst.toISOString().slice(0, 10);

      /* 오늘 할인으로 판매된 크레딧 수 조회 */
      const { data: logs } = await supabase
        .from('credit_logs')
        .select('amount')
        .eq('type', 'charge')
        .gte('created_at', `${today}T00:00:00+09:00`)
        .lt('created_at', `${today}T23:59:59+09:00`);

      const sold = (logs || []).reduce((s, l) => s + (l.amount || 0), 0);
      const remaining = Math.max(0, DAILY_LIMIT - sold);
      const isSaleActive = remaining > 0;

      return res.status(200).json({
        success: true,
        isSaleActive,
        remaining,
        sold,
        dailyLimit: DAILY_LIMIT,
        salePrice: SALE_PRICE,
        normalPrice: NORMAL_PRICE,
        currentPrice: isSaleActive ? SALE_PRICE : NORMAL_PRICE,
        today
      });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });

  } catch (err) {
    console.error('daily-credit error:', err);
    /* API 오류 시 기본값 반환 (서비스 중단 방지) */
    return res.status(200).json({
      success: true,
      isSaleActive: true,
      remaining: DAILY_LIMIT,
      sold: 0,
      dailyLimit: DAILY_LIMIT,
      salePrice: SALE_PRICE,
      normalPrice: NORMAL_PRICE,
      currentPrice: SALE_PRICE,
    });
  }
}
