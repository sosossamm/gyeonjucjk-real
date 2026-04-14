export const config = { api: { bodyParser: true } };

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const DAILY_LIMIT   = 100;      /* 하루 할인 한도 */
const SALE_PRICE    = 10000;   /* 할인가 */
const NORMAL_PRICE  = 20000;   /* 정상가 */

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
      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const today = kst.toISOString().slice(0, 10); /* KST 기준 오늘 날짜 */

      /* UTC 기준 오늘 범위 계산 (DB는 UTC로 저장됨) */
      const todayStartUTC = `${today}T00:00:00+09:00`; /* KST 00:00 = UTC 전날 15:00 */
      const todayEndUTC   = `${today}T23:59:59+09:00`; /* KST 23:59 = UTC 당일 14:59 */

      /* 오늘 할인가(charge 타입)로 판매된 크레딧 수 조회 */
      const { data: logs } = await supabase
        .from('credit_logs')
        .select('amount')
        .eq('type', 'charge')
        .gte('created_at', todayStartUTC)
        .lte('created_at', todayEndUTC);

      const sold = (logs || []).reduce((s, l) => s + (l.amount || 0), 0);
      const remaining = Math.max(0, DAILY_LIMIT - sold);

      /* remaining이 0이면 할인 종료 → 정상가 적용 */
      const isSaleActive = remaining > 0;
      const currentPrice = isSaleActive ? SALE_PRICE : NORMAL_PRICE;

      return res.status(200).json({
        success: true,
        isSaleActive,
        remaining,
        sold,
        dailyLimit: DAILY_LIMIT,
        salePrice: SALE_PRICE,
        normalPrice: NORMAL_PRICE,
        currentPrice,
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
