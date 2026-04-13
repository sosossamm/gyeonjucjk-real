export const config = { api: { bodyParser: true } };

const UNIT_PRICE    = 10000; // 크레딧 1개 단가 (원)
const ALLOWED_QTYS  = [1, 3, 5]; // 허용된 충전 수량

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase 환경변수가 설정되지 않았습니다.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(supabase, token) {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

// 토스페이먼츠 결제 승인 요청
async function confirmTossPayment(paymentKey, orderId, amount) {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) throw new Error('TOSS_SECRET_KEY 환경변수가 설정되지 않았습니다.');
  const encoded = Buffer.from(secretKey + ':').toString('base64');
  const resp = await fetch('https://api.tosspayments.com/v2/payments/confirm', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${encoded}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://quote-analysis.site';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  const action = req.query.action;

  try {
    const supabase = await getSupabase();

    // ── rewardSharer: 공유 보상 ─────────────────────────────────────────────
    // 인증 불필요 (공유 링크 열람자가 트리거) — 단, 중복 방지 필수
    if (action === 'rewardSharer' && req.method === 'POST') {
      const { sharerId, shareId } = req.body || {};
      if (!sharerId || !shareId) {
        return res.status(400).json({ error: 'sharerId, shareId가 필요합니다.' });
      }

      // shareId 형식 검증 (임의 문자열 주입 방지)
      if (!/^[a-zA-Z0-9_:\-]{4,128}$/.test(shareId)) {
        return res.status(400).json({ error: '잘못된 shareId 형식입니다.' });
      }

      // 중복 보상 방지
      const { data: existing } = await supabase
        .from('credit_logs').select('id')
        .eq('user_id', sharerId)
        .eq('type', 'reward')
        .eq('description', `share:${shareId}`)
        .maybeSingle();

      if (existing) {
        return res.status(200).json({ success: true, message: '이미 지급됨' });
      }

      // 잔액 업데이트 (upsert)
      const { data: sharerData } = await supabase
        .from('users').select('credits').eq('id', sharerId).maybeSingle();

      if (!sharerData) {
        await supabase.from('users').insert({
          id: sharerId, credits: 1, created_at: new Date().toISOString()
        });
      } else {
        await supabase.from('users').update({
          credits: (sharerData.credits || 0) + 1
        }).eq('id', sharerId);
      }

      await supabase.from('credit_logs').insert({
        user_id: sharerId, amount: 1, type: 'reward',
        description: `share:${shareId}`, created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true });
    }

    // 이하 모든 액션은 로그인 필수
    const user = await getUser(supabase, token);
    if (!user) return res.status(401).json({ error: '로그인이 필요해요' });

    // ── balance: 잔액 조회 ──────────────────────────────────────────────────
    if (action === 'balance') {
      const { data } = await supabase
        .from('users').select('credits').eq('id', user.id).maybeSingle();

      if (!data) {
        await supabase.from('users').upsert({
          id: user.id,
          email: user.email,
          name: user.user_metadata?.name || '',
          credits: 0,
          created_at: new Date().toISOString(),
        });
        return res.status(200).json({ credits: 0 });
      }
      return res.status(200).json({ credits: data.credits || 0 });
    }

    // ── use: 크레딧 1개 차감 ────────────────────────────────────────────────
    if (action === 'use' && req.method === 'POST') {
      const { description = '상세 분석 열람' } = req.body || {};

      const { data: userData } = await supabase
        .from('users').select('credits').eq('id', user.id).maybeSingle();
      const currentCredits = userData?.credits || 0;

      if (currentCredits < 1) {
        return res.status(400).json({ error: '크레딧이 부족해요' });
      }

      // 동시성 제어 — credits 값이 변하지 않았을 때만 차감
      const { data: updated, error: updateErr } = await supabase
        .from('users')
        .update({ credits: currentCredits - 1 })
        .eq('id', user.id)
        .eq('credits', currentCredits) // 동시 요청으로 이미 차감됐으면 업데이트 안 됨
        .select('credits')
        .single();

      if (updateErr || !updated) {
        return res.status(409).json({ error: '크레딧 차감에 실패했습니다. 다시 시도해주세요.' });
      }

      await supabase.from('credit_logs').insert({
        user_id: user.id, amount: -1, type: 'use',
        description, created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true, credits: updated.credits });
    }

    // ── reward: 토스 결제 후 크레딧 충전 ────────────────────────────────────
    if (action === 'reward' && req.method === 'POST') {
      const { paymentKey, orderId, type = 'charge' } = req.body || {};

      // 필수값 검증
      if (!paymentKey || !orderId) {
        return res.status(400).json({ error: 'paymentKey, orderId가 필요합니다.' });
      }

      // orderId 형식 검증 (CRD-로 시작해야 함)
      if (!/^CRD-\d+$/.test(orderId)) {
        return res.status(400).json({ error: '잘못된 주문 번호 형식입니다.' });
      }

      // 중복 처리 방지 — 같은 orderId로 이미 충전됐는지 확인
      const { data: existing } = await supabase
        .from('credit_logs').select('id, amount')
        .eq('order_id', orderId)
        .maybeSingle();

      if (existing) {
        const { data: userData } = await supabase
          .from('users').select('credits').eq('id', user.id).maybeSingle();
        return res.status(200).json({
          success: true,
          credits: userData?.credits ?? 0,
          chargedQty: 0,
          message: 'already_processed',
        });
      }

      // 토스 결제 승인 — ALLOWED_QTYS 순서로 금액 시도
      let tossResult = null;
      let chargedQty = 0;

      for (const qty of ALLOWED_QTYS) {
        const amount = qty * UNIT_PRICE;
        const result = await confirmTossPayment(paymentKey, orderId, amount);

        if (result.ok && result.data.status === 'DONE') {
          tossResult = result.data;
          chargedQty = qty;
          break;
        }
        // 이미 승인된 결제를 재시도한 경우
        if (result.data?.code === 'ALREADY_PROCESSED') {
          return res.status(409).json({ error: '이미 처리된 결제입니다.' });
        }
        // 금액 불일치 외 다른 오류면 바로 중단
        if (result.data?.code && result.data.code !== 'NOT_FOUND_PAYMENT') {
          console.error('Toss error:', result.data);
          return res.status(400).json({
            error: result.data.message || '결제 승인에 실패했습니다.',
          });
        }
      }

      if (!tossResult || chargedQty === 0) {
        console.error('Toss confirm failed for orderId:', orderId);
        return res.status(400).json({
          error: '결제 승인에 실패했습니다. 다시 시도하거나 고객센터로 문의해주세요.',
        });
      }

      // 크레딧 적립
      const { data: userData } = await supabase
        .from('users').select('credits').eq('id', user.id).maybeSingle();
      const currentCredits = userData?.credits || 0;
      const newCredits = currentCredits + chargedQty;

      const { error: updateErr } = await supabase
        .from('users')
        .update({ credits: newCredits })
        .eq('id', user.id);

      if (updateErr) throw updateErr;

      // 충전 내역 기록 (order_id 포함 — 중복 충전 방지 핵심)
      await supabase.from('credit_logs').insert({
        user_id: user.id,
        amount: chargedQty,
        type,
        description: `크레딧 ${chargedQty}개 충전 (₩${(chargedQty * UNIT_PRICE).toLocaleString('ko-KR')})`,
        order_id: orderId,
        payment_key: paymentKey,
        created_at: new Date().toISOString(),
      });

      // daily sale 카운팅 — Supabase RPC로 직접 처리 (HTTP 호출 없음)
      try {
        await supabase.rpc('increment_daily_sold', { qty: chargedQty });
      } catch(e) {
        console.error('daily sale 카운팅 실패 (결제는 정상):', e.message);
      }

      return res.status(200).json({
        success: true,
        credits: newCredits,
        chargedQty,
        amount: chargedQty * UNIT_PRICE,
      });
    }

    // ── history: 내역 조회 ──────────────────────────────────────────────────
    if (action === 'history') {
      const { data, error } = await supabase
        .from('credit_logs').select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return res.status(200).json({ logs: data || [] });
    }

    return res.status(400).json({ error: '알 수 없는 요청' });

  } catch (err) {
    console.error('credits error:', err);
    // 내부 오류 메시지를 그대로 노출하지 않음
    return res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
}
