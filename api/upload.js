import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    /* multipart 파싱 */
    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) return res.status(400).json({ error: 'No boundary' });

    const parts = parseParts(buf, boundary);
    const filePart  = parts.find(p => p.name === 'file');
    const metaPart  = parts.find(p => p.name === 'meta');

    if (!filePart) return res.status(400).json({ error: 'No file' });

    /* 메타데이터 파싱 */
    const meta = metaPart ? JSON.parse(metaPart.data.toString()) : {};
    const { region, areaPy, totalAmount } = meta;

    /* 파일명 생성 */
    const ts   = Date.now();
    const ext  = filePart.filename?.split('.').pop() || 'bin';
    const path = `estimates/${ts}_${region||'unknown'}_${areaPy||0}py.${ext}`;

    /* Supabase Storage 업로드 */
    const { error: uploadErr } = await supabase.storage
      .from('estimates')
      .upload(path, filePart.data, {
        contentType: filePart.contentType || 'application/octet-stream',
        upsert: false,
      });

    if (uploadErr) throw uploadErr;

    /* IP 추출 */
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    /* Supabase DB 저장 */
    const { data: row, error: dbErr } = await supabase
      .from('estimate_logs')
      .insert({
        file_path:    path,
        file_type:    ext,
        region:       region || null,
        area_py:      areaPy  || null,
        total_amount: totalAmount || null,
        user_ip:      ip,
        analysis_result: null,   /* 분석 완료 후 update */
        created_at:   new Date().toISOString(),
      })
      .select('id')
      .single();

    if (dbErr) throw dbErr;

    return res.status(200).json({ success: true, logId: row.id, path });

  } catch (err) {
    console.error('upload error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/* ── multipart 파서 ── */
function parseParts(buf, boundary) {
  const sep   = Buffer.from('--' + boundary);
  const parts = [];
  let pos = 0;

  while (pos < buf.length) {
    const start = indexOf(buf, sep, pos);
    if (start === -1) break;
    pos = start + sep.length;

    if (buf[pos] === 0x2d && buf[pos+1] === 0x2d) break; /* -- 끝 */
    if (buf[pos] === 0x0d) pos += 2; /* \r\n */

    /* 헤더 파싱 */
    const headerEnd = indexOf(buf, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headerStr = buf.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;

    const nameMatch     = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch       = headerStr.match(/Content-Type:\s*(.+)/i);

    const nextSep  = indexOf(buf, sep, pos);
    const dataEnd  = nextSep === -1 ? buf.length : nextSep - 2; /* \r\n */
    const data     = buf.slice(pos, dataEnd);
    pos = nextSep === -1 ? buf.length : nextSep;

    parts.push({
      name:        nameMatch?.[1] || '',
      filename:    filenameMatch?.[1] || '',
      contentType: ctMatch?.[1]?.trim() || 'text/plain',
      data,
    });
  }
  return parts;
}

function indexOf(buf, search, offset = 0) {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}
