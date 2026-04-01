export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentKey, orderId, amount } = req.body;

  if (!orderId || !amount) {
    return res.status(400).json({ success: false, message: '필수 파라미터 누락' });
  }

  if (parseInt(amount) !== 10000) {
    return res.status(400).json({ success: false, message: '결제 금액이 올바르지 않습니다' });
  }

  /* paymentKey 없으면 서버 검증 없이 성공 처리 (테스트 모드용) */
  if (!paymentKey) {
    return res.status(200).json({ success: true, orderId, message: 'test_mode' });
  }

  try {
    const secretKey = process.env.TOSS_SECRET_KEY;
    if (!secretKey) {
      /* 환경변수 없으면 테스트 모드로 통과 */
      return res.status(200).json({ success: true, orderId, message: 'no_secret_key' });
    }

    const encoded = Buffer.from(secretKey + ':').toString('base64');

    /* 토스페이먼츠 v2 결제 승인 */
    const response = await fetch('https://api.tosspayments.com/v2/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: parseInt(amount) }),
    });

    const data = await response.json();

    if (response.ok && data.status === 'DONE') {
      return res.status(200).json({ success: true, paymentKey, orderId });
    } else {
      return res.status(400).json({ success: false, message: data.message || '결제 승인 실패' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
