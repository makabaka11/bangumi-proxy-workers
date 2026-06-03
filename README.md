# Bangumi Proxy Workers

Cloudflare Worker 实现的反向代理，用于代理 Bangumi (bgm.tv) 的 API 和图片 CDN。

- **主API**：`api.bgm.tv` → 你的 API 域名
- **评论API**：`next.bgm.tv` → 你的 API 域名（同主API）
- **图片**：`lain.bgm.tv` → 你的图片域名（带边缘缓存）
- **自动改写**：API 响应中的图片链接自动替换为你的图片域名
- **路径前缀保护**：可选的随机字符串路径前缀，防止未授权访问

---

## Quick Start

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/makabaka11/bangumi-proxy-workers)

1. 点击上方 **Deploy** 按钮，按引导完成部署
2. 部署完成后进入 Worker → **Settings** → **Domains & Routes** → **Add Custom Domain**，绑定你的两个域名
3. 编辑 Worker 代码，修改 `CONFIG` 区域：

```js
const API_HOST = "your-api-domain.example.com";   // 你的 API 域名
const IMG_HOST = "your-img-domain.example.com";   // 你的图片域名

// 可选：路径前缀（推荐设置，防止未授权访问）
// 设为空字符串 "" 则禁用
const PATH_PREFIX = "your-random-string";
```

4. 重新部署即可

---

## 配置说明

### CONFIG 变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `API_HOST` | 代理 API 的域名 | `"example.com"` |
| `IMG_HOST` | 代理图片的域名 | `"bgmimg.example.com"` |
| `PATH_PREFIX` | 路径前缀（可选），设为 `""` 禁用 | `"abc123xyz"` |
| `IMG_CACHE_TTL` | 图片缓存时长（秒） | `30 * 24 * 60 * 60`（30天） |

### 路径前缀

设置 `PATH_PREFIX` 后，所有请求必须带上此前缀才会被代理：

```
# 无前缀 → 404
https://example.com/v0/search/subjects?keyword=test

# 带前缀 → 正常代理
https://example.com/abc123xyz/v0/search/subjects?keyword=test
```

API 响应中的图片链接也会自动加上前缀：

```json
{
  "images": {
    "large": "https://bgmimg.example.com/abc123xyz/pic/cover/l/ab/cd/12345.jpg"
  }
}
```

> **提示**：用 `openssl rand -hex 16` 生成一个强随机前缀。

---

## 使用示例

### 健康检查

```
GET https://example.com/abc123xyz/__health
```

```json
{
  "ok": true,
  "host": "example.com",
  "role": "api",
  "upstream": "api.bgm.tv",
  "apiHost": "example.com",
  "imgHost": "bgmimg.example.com",
  "pathPrefix": "abc123xyz"
}
```

### 搜索条目

```
GET https://example.com/abc123xyz/v0/search/subjects?keyword=吹响!上低音号
```

### 获取条目详情

```
GET https://example.com/abc123xyz/v0/subjects/12345
```

### 获取图片

```
GET https://bgmimg.retr0.xyz/abc123xyz/pic/cover/l/ab/cd/12345.jpg
```

首次请求 `MISS`，后续命中 Cloudflare 边缘缓存 `HIT`。

---

## 架构

```
客户端
  │
  ├── https://example.com/abc123xyz/v0/...  ──→  Worker  ──→  api.bgm.tv
  │    (API 域名)                                    │
  │                                                  ├── 检查路径前缀
  │                                                  ├── 剥离前缀，转发请求
  │                                                  ├── 改写响应中的图片域名
  │                                                  └── 返回
  │
  └── https://bgmimg.example.com/abc123xyz/...  ──→  Worker  ──→  lain.bgm.tv
       (图片域名)                                               └── 边缘缓存
```

---

## 域名配置

你需要两个域名，可以是任意根域下的子域名：

| 角色 | 示例 | 用途 |
|---|---|---|
| API | `example.com` | 代理 Bangumi API |
| 图片 | `bgmimg.example.com` | 代理 Bangumi 图片 CDN |

两个域名都绑定到同一个 Worker 即可，Worker 根据请求的 `Host` 头自动区分角色。

---

## 注意事项

- 该 Worker 仅代理 Bangumi **v0 REST API**（`api.bgm.tv`），不适用于 GraphQL 端点
- `PATH_PREFIX` 为可选功能，但建议设置以防止被扫描和滥用
- 图片缓存时间默认为 30 天，Bangumi 的图片 URL 是稳定不变的（基于内容哈希），可以放心缓存

---

## 鸣谢

本脚本基于 [Yuri-NagaSaki/bangumi-proxy](https://github.com/Yuri-NagaSaki/bangumi-proxy) 修改而来。
