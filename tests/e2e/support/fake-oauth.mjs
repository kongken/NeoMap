// 端到端测试用的假 OAuth 服务（GitHub / Google 兼容端点），仅供本地与测试使用。
// - /authorize 自动同意并回跳（client_id 为 deny 时模拟用户拒绝）
// - /token 校验 PKCE（code_verifier 的 S256 必须与 code_challenge 一致）
// - 每次启动使用新的用户 ID，使每轮测试都是全新账号
import http from 'node:http'
import crypto from 'node:crypto'

const port = Number(process.env.FAKE_OAUTH_PORT ?? 9099)
const runId = Date.now()
const codes = new Map()

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${port}`)
    const json = (o, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
    if (u.pathname === '/health') return json({ ok: true, runId })
    if (u.pathname === '/authorize') {
      const code = crypto.randomBytes(8).toString('hex')
      codes.set(code, u.searchParams.get('code_challenge'))
      const back = new URL(u.searchParams.get('redirect_uri'))
      if (u.searchParams.get('client_id') === 'deny') back.searchParams.set('error', 'access_denied')
      else back.searchParams.set('code', code)
      back.searchParams.set('state', u.searchParams.get('state'))
      res.writeHead(302, { Location: back.toString() }).end()
      return
    }
    if (u.pathname === '/token') {
      let body = ''
      for await (const c of req) body += c
      const f = new URLSearchParams(body)
      const expected = codes.get(f.get('code'))
      codes.delete(f.get('code'))
      const got = crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url')
      if (!expected || expected !== got) return json({ error: 'invalid_grant' }, 400)
      return json({ access_token: 'fake-token', token_type: 'bearer' })
    }
    if (u.pathname === '/github/user') return json({ id: runId, login: 'e2e-tester', name: 'E2E Tester', avatar_url: '' })
    if (u.pathname === '/github/emails') return json([{ email: 'e2e@example.com', primary: true, verified: true }])
    if (u.pathname === '/google/userinfo') return json({ sub: `g-${runId}`, name: 'E2E Google', email: 'e2e-g@example.com', email_verified: true, picture: '' })
    res.writeHead(404).end()
  })
  .listen(port, () => console.log(`fake oauth on :${port}`))
