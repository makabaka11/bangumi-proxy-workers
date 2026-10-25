# Bangumi Proxy Workers

一个 Cloudflare Worker，通过三个自定义域名代理 Bangumi 的主站、API 和图片。

| 配置 | 上游 | 示例 |
|---|---|---|
| `API_HOST` | `api.bgm.tv`，`/p1`、`/p1/*` 转到 `next.bgm.tv` | `bgmapi.example.com` |
| `IMG_HOST` | `lain.bgm.tv`，带边缘缓存 | `bgmimg.example.com` |
| `WEB_HOST` | `bgm.tv` 主站 | `bgm.example.com` |

主站的封面、头像与 API 返回的图片都使用 `lain.bgm.tv`，统一改写到 `IMG_HOST`，复用同一份图片缓存。

## 部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/makabaka11/bangumi-proxy-workers)

1. 通过上方按钮部署，或将 `worker.js` 粘贴到 Cloudflare Dashboard → Workers & Pages 创建的 Worker 中。
2. 编辑脚本顶部配置，域名只填写主机名，不带协议和路径：

```js
const API_HOST = "bgmapi.example.com";
const IMG_HOST = "bgmimg.example.com";
const WEB_HOST = "bgm.example.com";
const PATH_PREFIX = "abc123xyz"; // API / 图片可选前缀；设为 "" 禁用
```

3. 在同一 Worker 的 Settings → Domains & Routes → Add Custom Domain 中绑定这三个不同的域名，然后重新部署。
4. 访问 `https://bgm.example.com/` 打开主站。已有部署只需新增并绑定 `WEB_HOST`；原有 API、图片配置可以保留。

使用 Wrangler 时可在本目录运行 `npx wrangler deploy`。三个域名仍需要绑定到该 Worker。

## 访问路径

| 功能 | 示例 |
|---|---|
| 主站首页 | `https://bgm.example.com/` |
| 主站条目 | `https://bgm.example.com/subject/12345` |
| API 条目 | `https://bgmapi.example.com/abc123xyz/v0/subjects/12345` |
| 评论 API | `https://bgmapi.example.com/abc123xyz/p1/...` |
| 图片 | `https://bgmimg.example.com/abc123xyz/pic/cover/l/ab/cd/12345.jpg` |
| 主站健康检查 | `https://bgm.example.com/__health` |
| API 健康检查 | `https://bgmapi.example.com/abc123xyz/__health` |
| 图片健康检查 | `https://bgmimg.example.com/abc123xyz/__health` |

`PATH_PREFIX` **仅作用于 API 和图片域名**。主站在根路径运行，让站内相对链接、动态脚本、表单、Cookie 路径保持正常；不要给主站 URL 添加此前缀。主站内改写出的 API、图片 URL 会自动携带配置的前缀。

前缀不是用户认证，公开主站页面及健康检查也可能暴露此前缀。需要访问控制时，请另外配置 Cloudflare Access 等机制。

## 代理行为

- HTML、CSS、JavaScript、JSON、XML 中的完整上游地址自动改写，支持协议相对地址和 JSON 转义斜杠。主站的 `bgm.tv`、`bangumi.tv`、`chii.in` 链接都指向 `WEB_HOST`，图片指向 `IMG_HOST`，API 指向 `API_HOST`。
- 源站跳转通过 `redirect: "manual"` 返回客户端，并改写 `Location`。保留外站链接、外站跳转，不任意代理第三方站点。
- 主站请求保留 HTTP 方法、请求正文及 Cookie；可信主站的 `Origin`、`Referer` 转回源站。多个 `Set-Cookie` 分别透传并去除源站 Domain，保留其他属性，使 Cookie 归属当前主站代理域。
- 主站响应使用 `private, no-store`，避免用户页面共享缓存。文本改写后移除源站长度、编码及 ETag 等失效元数据。
- 图片成功响应默认缓存 30 天，可修改 `IMG_CACHE_TTL`；有 Cookie、Authorization、Range 的请求及 HEAD 不读写共享缓存，错误响应和带 Set-Cookie 的响应不缓存。`x-cache` 显示 `HIT` / `MISS`。
- API / 图片保留通用 CORS；来自配置主站的跨域请求额外允许凭证，并设置 `Vary: Origin`。主站 OPTIONS 透传源站。
- 未配置的 Host 返回 404；上游请求超时或失败返回不可缓存的 502。不会自动重试登录、发帖等写入请求。

## 验证与限制

本地回归测试（Node.js 22 或更新版本，无第三方依赖）：

```sh
node --test worker.test.mjs
```

测试覆盖域名路由、前缀边界、响应改写、POST、Cookie、跳转、CORS、图片缓存、HEAD、无正文状态及网络失败。测试使用模拟上游和缓存，不能代替 Cloudflare 上线后的浏览器测试。

部署后检查：首页与条目页样式、封面和头像，站内导航、搜索，登录跳转及会话保持；在浏览器 Network 中确认图片走 `IMG_HOST`，重复读取可命中缓存。主站动态生成的特殊地址、第三方登录、验证码、防机器人挑战及未代理的第三方资源仍取决于上游行为，需要实际部署验证。代理不能保证绕过源站的访问限制。

## 鸣谢

本脚本基于 [Yuri-NagaSaki/bangumi-proxy](https://github.com/Yuri-NagaSaki/bangumi-proxy) 修改而来。
