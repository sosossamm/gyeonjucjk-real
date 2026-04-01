export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentKey, orderId, amount } = req.body;

  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ success: false, message: '필수 파라미터 누락' });
  }

  if (parseInt(amount) !== 10000) {
    return res.status(400).json({ success: false, message: '결제 금액이 올바르지 않습니다' });
  }

  try {
    // 토스페이먼츠 결제 승인 API 호출
    const secretKey = process.env.TOSS_SECRET_KEY; // Vercel 환경변수
    const encoded = Buffer.from(secretKey + ':').toString('base64');

    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
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
