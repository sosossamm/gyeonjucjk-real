export default async function handler(req, res) {
  // CORS — 실제 도메인만 허용 (현재 * 는 모든 도메인 허용이라 위험)
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://quote-analysis.site';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).json({ ok: true });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { paymentKey, orderId } = body;
    // amount는 클라이언트에서 받지 않음 — 서버에서 직접 결정

    // paymentKey, orderId 모두 필수
    if (!paymentKey || !orderId) {
      return res.status(400).json({ success: false, message: '필수 파라미터 누락' });
    }

    // orderId 형식 검증 (EST- 또는 CRD- 로 시작하는지)
    if (!/^(EST|CRD)-\d+$/.test(orderId)) {
      return res.status(400).json({ success: false, message: '잘못된 주문 번호 형식' });
    }

    // 시크릿 키 없으면 서버 설정 오류 — 성공 처리하면 절대 안 됨
    const secretKey = process.env.TOSS_SECRET_KEY;
    if (!secretKey) {
      console.error('TOSS_SECRET_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({ success: false, message: '서버 설정 오류. 관리자에게 문의해주세요.' });
    }

    // 금액은 서버에서 orderId 기준으로 결정 (클라이언트 값 신뢰 안 함)
    // TODO: DB에서 조회하는 방식으로 교체 권장
    // const order = await db.orders.findOne({ orderId });
    // const amount = order.amount;
    const amount = 10000; // 현재는 단일 상품이라 고정값 사용

    // 토스페이먼츠 결제 승인 요청
    const encoded = Buffer.from(secretKey + ':').toString('base64');
    const tossResp = await fetch('https://api.tosspayments.com/v2/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
    });

    let tossData = {};
    try { tossData = await tossResp.json(); } catch(e) {}

    if (tossResp.ok && tossData.status === 'DONE') {
      // 성공 — 클라이언트에 금액도 함께 반환 (GA 이벤트용)
      return res.status(200).json({
        success: true,
        paymentKey,
        orderId,
        amount: tossData.totalAmount || amount,
        credits: 1,
      });
    }

    // 토스 검증 실패 = 결제 실패 — 성공으로 덮으면 안 됨
    console.error('Toss verify failed:', JSON.stringify(tossData));
    return res.status(400).json({
      success: false,
      message: tossData.message || '결제 검증에 실패했어요. 다시 시도해주세요.',
      code: tossData.code,
    });

  } catch (err) {
    // 서버 오류 = 검증 불가 — 성공 처리 절대 금지
    console.error('verify error:', err);
    return res.status(500).json({
      success: false,
      message: '결제 확인 중 오류가 발생했어요. 결제가 완료됐다면 고객센터로 문의해주세요.',
    });
  }
}
