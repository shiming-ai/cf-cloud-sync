// ============================================================
// Crazy Friday · 云端同步后端（Netlify Functions 版）
// ------------------------------------------------------------
// 解决三件事：
//   1. 客户名单不再只躺在一台设备的 localStorage 里（换机/清缓存不丢）
//   2. 激活码云端登记，停用即时生效，使用时长可统计
//   3. 多设备打开后台看到的是同一份数据
//
// 存储：GitHub 仓库文件（AES-256-GCM 加密后落盘）
//   - 密钥只存在 Netlify 环境变量里，前端永远拿不到
//   - 仓库里是密文，即使仓库可见也读不出内容
// ============================================================

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const json = (obj, status = 200) => ({ statusCode: status, headers: CORS, body: JSON.stringify(obj) });

const REPO = process.env.GH_REPO || 'shiming-ai/shiming-workbench';
const FILE = process.env.GH_PATH || '_cloud/xhs-data.enc';
const BRANCH = process.env.GH_BRANCH || 'main';
const TOKEN = process.env.GH_TOKEN || '';
const ADMIN = process.env.ADMIN_SECRET || 'Cf26xhs8!@L1c3nse';
const ENCKEY = process.env.ENC_KEY || '';

/* ---------- 加解密 ---------- */
function enc(obj) {
  if (!ENCKEY) return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); // 未配密钥则明文（不推荐）
  const key = Buffer.from(ENCKEY, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
function dec(b64) {
  if (!ENCKEY) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0, 12), tag = buf.slice(12, 28), data = buf.slice(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCKEY, 'hex'), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

/* ---------- GitHub 读写 ---------- */
const GH_H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'cf-cloud-sync',
  'content-type': 'application/json',
};
const EMPTY = () => ({ customers: [], codes: {}, meta: null, aikey: '' });

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}?ref=${BRANCH}`, { headers: GH_H });
  if (r.status === 404) return { data: EMPTY(), sha: null };
  if (!r.ok) throw new Error('github read ' + r.status);
  const j = await r.json();
  let data;
  try {
    data = dec(Buffer.from((j.content || '').replace(/\n/g, ''), 'base64').toString('utf8'));
  } catch (e) {
    data = EMPTY();
  }
  if (!data || typeof data !== 'object') data = EMPTY();
  data.customers = Array.isArray(data.customers) ? data.customers : [];
  data.codes = data.codes && typeof data.codes === 'object' ? data.codes : {};
  return { data, sha: j.sha };
}

async function ghPut(data, sha) {
  const content = Buffer.from(enc(data), 'utf8').toString('base64');
  const body = { message: 'cloud sync ' + new Date().toISOString(), content, branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
    method: 'PUT', headers: GH_H, body: JSON.stringify(body),
  });
  if (r.status === 409) {                       // 并发冲突：重读一次再写
    const g = await ghGet();
    return ghPut(Object.assign({}, g.data, data), g.sha);
  }
  if (!r.ok) throw new Error('github write ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return true;
}

/* ---------- 主处理 ---------- */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  let p = (event.path || '/').replace(/^\/\.netlify\/functions\/[^\/]+/, '').replace(/^\/api/, '');
  p = p.replace(/\/+$/, '') || '/';
  const q = event.queryStringParameters || {};

  // 先解析一次 body，公开接口（/verify、/data-backup）凭激活码访问，不需要卖家密钥
  let body0 = {};
  if (event.httpMethod === 'POST') { try { body0 = JSON.parse(event.body || '{}'); } catch (e) { body0 = {}; } }
  for (const k in q) if (!(k in body0)) body0[k] = q[k];

  try {
    if (p === '/ping') return json({ ok: true, name: 'Crazy Friday 云端同步', ts: Date.now() });

    // ---------- 公开业务接口（凭激活码，无需卖家密钥） ----------
    if (p === '/verify' || p === '/data-backup') {
      const st = await ghGet();
      const data = st.data;
      data.backups = data.backups || {};

      if (p === '/verify') {
        const code = String(body0.code || '').trim();
        const uid = String(body0.uid || '').trim();
        if (!code) return json({ ok: false, reason: '缺少激活码', code: 'bad_param' });
        const rec = data.codes[code];
        // 云端没登记过 → 宽容放行，让客户端用码内自带信息激活（老客户不受影响）
        if (!rec) return json({ ok: true, data: null, unregistered: true });
        // 注意：必须带 code 字段，客户端按 code 分类决定是否停用（缺 code 会被当作服务端故障而放行）
        if (rec.status === 'revoked') return json({ ok: false, reason: '该授权已被停用，请联系卖家', code: 'revoked' });
        if (rec.uid && uid && rec.uid !== uid) return json({ ok: false, reason: '激活码与当前链接不匹配', code: 'mismatch' });
        const today = new Date().toISOString().slice(0, 10);
        if (rec.expireAt && rec.expireAt < today) return json({ ok: false, reason: '该激活码已过期，请联系卖家续费', code: 'expired' });
        rec.lastSeen = Date.now();
        rec.days = rec.days || {};
        rec.days[today] = 1;
        await ghPut(data, st.sha);
        return json({
          ok: true,
          data: { expireAt: rec.expireAt || '', plan: rec.plan || '', status: rec.status || 'active' },
        });
      }

      // /data-backup：客户工作数据云备份（换设备 / 清缓存自动恢复）
      const code = String((event.httpMethod === 'GET' ? q.code : body0.code) || '').trim();
      const uid = String((event.httpMethod === 'GET' ? q.uid : body0.uid) || '').trim();
      if (!code) return json({ ok: false, reason: '缺少激活码', code: 'bad_param' });
      if (event.httpMethod === 'GET') {
        const b = data.backups[code];
        return json({ ok: true, data: b ? b.data : null, savedAt: b ? b.savedAt : '' });
      }
      if (body0.data === undefined) return json({ ok: false, reason: '缺少 data', code: 'bad_param' });
      data.backups[code] = { uid, data: body0.data, savedAt: new Date().toISOString() };
      await ghPut(data, st.sha);
      return json({ ok: true, savedAt: data.backups[code].savedAt });
    }

    let body = body0;

    const given = q.secret || body.secret || '';
    if (given !== ADMIN) return json({ ok: false, reason: '密钥错误' }, 401);

    const store = await ghGet();

    if (p === '/status') {
      return json({
        ok: true, product: 'xhs',
        customers: store.data.customers.length,
        codes: Object.keys(store.data.codes).length,
        sha: store.sha ? store.sha.slice(0, 7) : null,
        ts: Date.now(),
      });
    }

    if (p === '/api/product') {
      return json({ ok: !!store.data.meta, data: store.data.meta });
    }

    if (p === '/api/customers') {
      if (event.httpMethod === 'GET') return json({ ok: true, customers: store.data.customers, ts: Date.now() });
      const list = Array.isArray(body.customers) ? body.customers : null;
      if (!list) return json({ ok: false, reason: '缺少 customers' });
      store.data.customers = list;
      await ghPut(store.data, store.sha);
      return json({ ok: true, saved: list.length });
    }

    if (p === '/issue') {
      if (!body.code) return json({ ok: false, reason: '缺少 code' });
      if (store.data.codes[body.code]) {
        return json({ ok: false, reason: '激活码已存在，请勿重复登记' });
      }
      store.data.codes[body.code] = {
        uid: body.uid || '', expireAt: body.expireAt || '', plan: body.plan || '',
        status: 'active', ts: Date.now(),
      };
      await ghPut(store.data, store.sha);
      return json({ ok: true });
    }

    if (p === '/revoke' || p === '/unrevoke') {
      if (!body.code) return json({ ok: false, reason: '缺少 code' });
      if (!store.data.codes[body.code]) return json({ ok: false, reason: '激活码不存在' });
      store.data.codes[body.code].status = p === '/revoke' ? 'revoked' : 'active';
      await ghPut(store.data, store.sha);
      return json({ ok: true, status: store.data.codes[body.code].status });
    }

    if (p === '/usage') {
      const codes = store.data.codes;
      return json({ ok: true, usage: codes, total: Object.keys(codes).length });
    }

    if (p === '/ai-config') {
      if (body.apiKey !== undefined) {
        store.data.aikey = String(body.apiKey || '');
        await ghPut(store.data, store.sha);
      }
      return json({ ok: true });
    }
    if (p === '/ai-status') return json({ ok: true, configured: !!store.data.aikey });

    if (p === '/set-product') {
      store.data.meta = { name: body.name || 'xhs', ts: Date.now() };
      await ghPut(store.data, store.sha);
      return json({ ok: true });
    }

    return json({ ok: false, reason: '未知接口 ' + p }, 404);
  } catch (e) {
    return json({ ok: false, reason: '服务器错误: ' + (e && e.message ? e.message.slice(0, 120) : e) }, 500);
  }
};
