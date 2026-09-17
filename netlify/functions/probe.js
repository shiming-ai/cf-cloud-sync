exports.handler = async () => {
  const raw = process.env.NETLIFY_BLOBS_CONTEXT || '';
  let ctx = null;
  try { ctx = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e) {}
  const out = { hasCtx: !!raw, keys: ctx ? Object.keys(ctx) : null, tests: [] };
  if (!ctx) return { statusCode: 200, headers:{'content-type':'application/json'}, body: JSON.stringify(out) };
  const base = ctx.apiURL, site = ctx.siteID, tok = ctx.token;
  out.apiURL = base;
  const variants = [
    ['q', `${base}/${site}/cfstore?key=probe`],
    ['p', `${base}/${site}/cfstore/probe`],
  ];
  for (const [n, u] of variants) {
    try { const r = await fetch(u, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1 }) });
      out.tests.push({ n: 'PUT-' + n, s: r.status, b: (await r.text()).slice(0, 80) }); } catch (e) { out.tests.push({ n: 'PUT-' + n, e: String(e).slice(0, 70) }); }
  }
  for (const [n, u] of variants) {
    try { const r = await fetch(u, { headers: { authorization: `Bearer ${tok}` } });
      out.tests.push({ n: 'GET-' + n, s: r.status, b: (await r.text()).slice(0, 80) }); } catch (e) { out.tests.push({ n: 'GET-' + n, e: String(e).slice(0, 70) }); }
  }
  return { statusCode: 200, headers:{'content-type':'application/json'}, body: JSON.stringify(out, null, 2) };
};
