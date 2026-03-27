import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body   = req.body;
    const logId  = body._logId;   /* 프론트에서 넘긴 logId (선택) */
    delete body._logId;
    body.max_tokens = 6000;

    /* Anthropic API 호출 */
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    /* 분석 결과를 Supabase DB에 저장 (logId 있을 때만) */
    if (logId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );
        const rawText = (data.content || []).map(b => b.text || '').join('');
        const match   = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          await supabase
            .from('estimate_logs')
            .update({ analysis_result: JSON.parse(match[0]) })
            .eq('id', logId);
        }
      } catch (dbErr) {
        console.error('DB update error (non-critical):', dbErr.message);
      }
    }

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
