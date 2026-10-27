import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Node 流式 Request 要求 duplex；Workers 原生 Request 不要求此选项。
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input, init) {
    super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } : init);
  }
};
// 测试使用固定域名配置，兼容本地与去敏版本，避免依赖部署域名。
const source = (await readFile(new URL('./worker.js', import.meta.url), 'utf8'))
  .replace(/const API_HOST = "[^"]*";/, 'const API_HOST = "bgm.example.com";')
  .replace(/const IMG_HOST = "[^"]*";/, 'const IMG_HOST = "bgmimg.example.com";')
  .replace(/const WEB_HOST = "[^"]*";/, 'const WEB_HOST = "bgmweb.example.com";')
  .replace(/const PATH_PREFIX = "[^"]*";/, 'const PATH_PREFIX = "abc123xyz";');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const api = 'https://bgm.example.com/abc123xyz';
const img = 'https://bgmimg.example.com/abc123xyz';
const web = 'https://bgmweb.example.com';
let upstream, seen, entries, pending;
function reset() {
  seen = []; entries = new Map(); pending = [];
  upstream = () => new Response('ok');
  globalThis.fetch = async request => { seen.push(request); return upstream(request); };
  globalThis.caches = { default: {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => { entries.set(key.url, response); },
  } };
}
async function run(url, init) {
  return worker.fetch(new Request(url, init), {}, { waitUntil: promise => pending.push(promise) });
}

test('三角色路由、健康检查和前缀边界', async () => {
  reset();
  for (const [base, role] of [[api, 'api'], [img, 'img'], [web, 'web']]) {
    assert.equal((await (await run(`${base}/__health`)).json()).role, role);
  }
  for (const url of ['https://unknown.example.com/', 'https://bgm.example.com/v0/a',
    'https://bgm.example.com/abc123xyz-other/v0/a']) assert.equal((await run(url)).status, 404);
  await run(`${api}/p1/comments?a=1`);
  assert.equal(seen.at(-1).url, 'https://next.bgm.tv/p1/comments?a=1');
  await run(`${web}/subject/1`);
  assert.equal(seen.at(-1).url, 'https://bgm.tv/subject/1');
});

test('HTML、内联脚本、CSS 和转义 JSON 复用图片代理且不误改外域', async () => {
  reset();
  const html = `<a href="https://bangumi.tv/subject/1">x</a>
    <script>var SITE_URL='https://bgm.tv';</script>
    <img src="//lain.bgm.tv/pic/a.jpg"><style>a{background:url(https://lain.bgm.tv/a)}</style>
    {"url":"https:\\/\\/lain.bgm.tv\\/pic\\/b.jpg"}
    https://api.bgm.tv/v0/subjects https://next.bgm.tv/p1/comments
    https://bgm.tv.evil.example/ https://lain.bgm.tv.evil.example/`;
  upstream = () => new Response(html, { headers: { 'content-type': 'text/html', etag: 'old', 'content-length': '5' } });
  const response = await run(web);
  const body = await response.text();
  assert.ok(body.includes(`${web}/subject/1`));
  assert.ok(body.includes(`SITE_URL='${web}'`));
  assert.ok(body.includes(`${img}/pic/a.jpg`));
  assert.ok(body.includes('https:\\/\\/bgmimg.example.com\\/abc123xyz\\/pic\\/b.jpg'));
  assert.ok(body.includes(`${api}/p1/comments`));
  assert.ok(body.includes('https://bgm.tv.evil.example/'));
  assert.ok(body.includes('https://lain.bgm.tv.evil.example/'));
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('POST 保留正文与 Cookie，恢复可信来源并手动返回重定向', async () => {
  reset();
  upstream = async request => {
    assert.equal(await request.text(), 'email=a%40b&password=secret');
    return new Response(null, { status: 302, headers: {
      location: 'https://chii.in/user/1',
      'set-cookie': 'sid=one; Domain=.bgm.tv; Path=/; HttpOnly; Secure; SameSite=Lax',
    } });
  };
  const response = await run(`${web}/login`, { method: 'POST',
    body: 'email=a%40b&password=secret', headers: {
      origin: web, referer: `${web}/login?next=1`, cookie: 'sid=old',
      'content-type': 'application/x-www-form-urlencoded', 'if-none-match': 'old',
    } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${web}/user/1`);
  assert.equal(response.headers.get('set-cookie'), 'sid=one; Path=/; HttpOnly; Secure; SameSite=Lax');
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[0].headers.get('origin'), 'https://bgm.tv');
  assert.equal(seen[0].headers.get('referer'), 'https://bgm.tv/login?next=1');
  assert.equal(seen[0].headers.get('cookie'), 'sid=old');
  assert.equal(seen[0].headers.get('if-none-match'), null);
});

test('多个 Cookie 独立保留，包括 Expires 的逗号；外站跳转和来源保持原样', async () => {
  reset();
  upstream = () => {
    const headers = new Headers({ location: 'https://example.org/auth' });
    headers.append('set-cookie', 'a=1; Domain=bgm.tv; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/');
    headers.append('set-cookie', 'b=2; Domain=.chii.in; HttpOnly; Path=/');
    return new Response(null, { status: 302, headers });
  };
  const response = await run(web, { headers: { origin: 'https://evil.example' } });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.ok(response.headers.getSetCookie()[0].includes('Wed, 01 Jan 2031'));
  assert.equal(response.headers.get('location'), 'https://example.org/auth');
  assert.equal(seen[0].headers.get('origin'), 'https://evil.example');
});

test('API 保留 JSON 和图片前缀；带凭证 CORS 只允许配置的主站', async () => {
  reset();
  upstream = () => Response.json({ image: 'https://lain.bgm.tv/pic/a.jpg' });
  const response = await run(`${api}/v0/subjects/1`, { headers: { origin: web } });
  assert.equal((await response.json()).image, `${img}/pic/a.jpg`);
  assert.equal(response.headers.get('access-control-allow-origin'), web);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  const other = await run(`${api}/v0/subjects/1`, { headers: { origin: 'https://other.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), '*');
  assert.equal(other.headers.get('access-control-allow-credentials'), null);
});

test('共享图床缓存、HEAD、Range、Cookie 与错误响应不污染缓存', async () => {
  reset();
  upstream = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  assert.equal((await run(`${img}/pic/a`)).headers.get('x-cache'), 'MISS');
  await Promise.all(pending);
  assert.equal((await run(`${img}/pic/a`)).headers.get('x-cache'), 'HIT');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://lain.bgm.tv/pic/a');
  assert.equal(await (await run(`${img}/pic/a`, { method: 'HEAD' })).text(), '');
  assert.equal(seen.at(-1).method, 'HEAD');
  await run(`${img}/pic/range`, { headers: { range: 'bytes=0-1' } });
  await run(`${img}/pic/private`, { headers: { cookie: 'sid=private' } });
  await Promise.all(pending);
  assert.equal(entries.size, 1);
  upstream = () => new Response('missing', { status: 404 });
  assert.equal((await run(`${img}/missing`)).status, 404);
  assert.equal((await run(`${img}/pic/a`, { method: 'POST', body: 'bad' })).status, 405);
  assert.equal(entries.size, 1);
});

test('HEAD/204/304 无正文；网络错误返回不可缓存 502，不重试 POST', async () => {
  reset();
  for (const status of [204, 304]) {
    upstream = () => new Response(null, { status, headers: { 'content-type': 'text/html' } });
    const response = await run(web);
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
  }
  reset();
  upstream = () => { throw new TypeError('network'); };
  const response = await run(`${web}/login`, { method: 'POST', body: 'a=1' });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(seen.length, 1);
});

test('禁用前缀时 API、图片及主站映射仍正常', async () => {
  reset();
  const noPrefix = source.replace('const PATH_PREFIX = "abc123xyz";', 'const PATH_PREFIX = "";');
  const alternate = (await import(`data:text/javascript;base64,${Buffer.from(noPrefix).toString('base64')}`)).default;
  upstream = () => Response.json({ image: '//lain.bgm.tv/pic/a' });
  const response = await alternate.fetch(new Request('https://bgm.example.com/v0/a'), {}, {});
  assert.equal((await response.json()).image, 'https://bgmimg.example.com/pic/a');
});

test('兼容旧 Workers 的 getAll(Set-Cookie)，相对跳转仍留在主站', async () => {
  reset();
  upstream = () => {
    const response = new Response(null, { status: 302, headers: {
      location: '/login?next=%2Fuser', 'set-cookie': 'sid=1; Domain=.bgm.tv; Path=/',
    } });
    const cookies = response.headers.getSetCookie();
    response.headers.getSetCookie = undefined;
    response.headers.getAll = name => {
      assert.equal(name, 'Set-Cookie');
      return cookies;
    };
    return response;
  };
  const response = await run(web);
  assert.equal(response.headers.get('location'), `${web}/login?next=%2Fuser`);
  assert.equal(response.headers.get('set-cookie'), 'sid=1; Path=/');
});

test('独立 CSS/JS 资源改写、二进制原样传输、缓存读取故障回源', async () => {
  reset();
  for (const ct of ['text/css', 'application/javascript']) {
    upstream = () => new Response('url(//lain.bgm.tv/pic/a)', { headers: { 'content-type': ct } });
    assert.equal(await (await run(`${web}/asset`)).text(), `url(${img}/pic/a)`);
  }
  upstream = () => new Response(new Uint8Array([0, 255, 42]), { headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual(new Uint8Array(await (await run(`${web}/binary`)).arrayBuffer()), new Uint8Array([0, 255, 42]));
  caches.default.match = async () => { throw new Error('cache failure'); };
  assert.equal((await run(`${img}/pic/a`)).status, 200);
  await Promise.all(pending);
});
