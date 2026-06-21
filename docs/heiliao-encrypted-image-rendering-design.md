# Heiliao 加密图片 Markdown 渲染特性设计

本文描述 Markdown Viewer 对 `pic.uforxk.cn` 加密图片的渲染支持方案。该方案基于现有架构文档和加密图片解密参考文档，目标是在 Markdown 渲染页面中自动识别、拉取、解密并展示 Heiliao 图片资源，同时尽量保持现有 Markdown 编译协议和页面渲染结构稳定。

## 1. 特性目标

当 Markdown 中出现图片 URL，且 URL 域名为 `pic.uforxk.cn` 时：

1. 内容渲染阶段识别该图片为 Heiliao 加密图片。
2. 预处理阶段让页面先显示浏览器默认破图表现。
3. 后处理阶段由后台服务拉取加密图片并使用 WebCrypto 解密。
4. 解密成功后将图片替换为本地 `blob:` URL 并渲染到 Markdown 页面中。
5. 解密失败时保持破图表现，不修改原始 `alt` 文本，不向正文插入错误 UI。

非 `pic.uforxk.cn` 图片不改变现有渲染行为。

## 2. 已确认设计决策

| 决策项 | 结论 |
| --- | --- |
| 配置地址 | 使用不带版本的 `https://heiliao.com/static/v4/__base/config/app.config.js` |
| 权限策略 | 在 manifest 中加入固定窄域名 host permissions |
| 需要的 host permissions | `https://heiliao.com/*`、`https://pic.uforxk.cn/*` |
| config 缓存 | 后台内存缓存，不使用 `chrome.storage.session` |
| 解密图片缓存 | 不跨页面缓存解密后的图片字节；同一页面内可对相同 URL 做 Promise 去重 |
| 预处理图片表现 | 不设置透明图或 fallback 图，显示浏览器默认破图图标 |
| 破图实现方式 | 将 `src` 改为无效地址，避免浏览器先请求一次加密图片 |
| `alt` 行为 | 预处理和失败状态均保留 Markdown 原始 `alt` |
| 失败 UI | 不插入正文错误 UI，不设置 `title` |
| 失败状态 | 只更新内部 `data-*` 状态并输出 `console.warn` |
| 布局稳定性 | 不额外预留高度，接受解密完成后的正常布局变化 |

## 3. 模块边界

该特性应作为现有内容增强能力实现，不进入 Markdown 编译器。

原因：

- 当前编译器接口是同步的 `compile(markdown) -> html`。
- 图片拉取和 WebCrypto 解密是异步流程。
- 架构文档建议内容渲染 pipeline 可演进为 `read -> compile -> postProcess -> render -> enhance`。
- 将解密放在后处理增强阶段，可以避免改动编译器协议和所有编译器适配器。

推荐新增模块：

| 文件 | 职责 |
| --- | --- |
| `content/heiliao-images.js` | 扫描、调度、替换 DOM 中的 Heiliao 加密图片 |
| `background/heiliao-images.js` | 拉取 config、解析密钥、拉取加密图片、WebCrypto 解密 |

需要改动的现有模块：

| 文件 | 改动 |
| --- | --- |
| `content/index.js` | HTML 渲染前预处理特殊图片；渲染后触发 Heiliao 图片后处理 |
| `background/messages.js` | 增加 Heiliao 图片解密消息分发 |
| `background/index.js` | 加载并注入 `background/heiliao-images.js` |
| `background/inject.js` | 注入 `content/heiliao-images.js` |
| `manifest.chrome.json` | 增加窄域名 host permissions |
| `manifest.firefox.json` | 增加窄域名 host permissions / optional permissions 对应项 |

## 4. 运行流程

### 4.1 Markdown 编译

现有流程保持不变：

```text
content/index.js
  -> chrome.runtime.sendMessage({ message: "markdown", markdown })
  -> background/messages.js
  -> active compiler
  -> html
  -> content/index.js
```

后台返回 HTML 后，内容脚本继续执行 emoji、mermaid class、toc、anchor 等已有后处理。

### 4.2 HTML 预处理

在 `state.html` 写入 DOM 前，内容脚本对 HTML 字符串做一次 DOM 级预处理：

1. 使用 `DOMParser` 解析 HTML。
2. 扫描所有 `img[src]`。
3. 用 `new URL(src, document.baseURI)` 解析图片地址。
4. 如果 `url.hostname === "pic.uforxk.cn"`：
   - 保留原始 `alt`。
   - 将原始图片 URL 保存到 `data-heiliao-encrypted-image-src`。
   - 设置 `data-heiliao-encrypted-image="pending"`。
   - 将 `src` 改为无效地址，例如 `about:invalid#heiliao-encrypted-image`。
5. 将处理后的 HTML 序列化回字符串。

示例：

```html
<img src="https://pic.uforxk.cn/upload_01/a.jpeg" alt="封面图">
```

预处理后：

```html
<img
  src="about:invalid#heiliao-encrypted-image"
  alt="封面图"
  data-heiliao-encrypted-image="pending"
  data-heiliao-encrypted-image-src="https://pic.uforxk.cn/upload_01/a.jpeg">
```

实际用户效果：

- 浏览器不会提前请求加密图片。
- 页面显示默认破图图标。
- 破图旁边的文字由原始 `alt` 决定。
- 如果原 Markdown 没有 `alt`，则只显示浏览器默认破图表现。

### 4.3 DOM 后处理

HTML 渲染到页面后，`content/heiliao-images.js` 扫描：

```js
document.querySelectorAll('img[data-heiliao-encrypted-image="pending"]')
```

对每张图片：

1. 读取 `data-heiliao-encrypted-image-src`。
2. 发消息给后台请求解密。
3. 后台返回解密后的图片 base64 字符串和 MIME。
4. 内容脚本将 base64 还原为 `Blob`，并创建或复用同 URL 的 `blob:` URL。
5. 将 `img.src` 替换为 `blob:` URL。
6. 设置 `data-heiliao-encrypted-image="loaded"`。
7. 在页面重新渲染或卸载前回收旧 `blob:` URL。
8. 如果异步解密结果属于旧渲染轮次，则丢弃结果，不再写入 DOM。

### 4.4 后台解密

`background/heiliao-images.js` 提供类似接口：

```js
decrypt(imageUrl) -> Promise<{mime, base64}>
```

内部流程：

1. 校验 `imageUrl` hostname 必须是 `pic.uforxk.cn`。
2. 获取 Heiliao config 参数：
   - 首次调用 fetch `https://heiliao.com/static/v4/__base/config/app.config.js`。
   - 解析 `media_key`、`media_iv`、`mode`。
   - 将 ASCII 数字串解码为真实 key/iv。
   - 将结果缓存在后台内存。
   - 对并发首次请求使用同一个 inflight Promise。
3. 校验 `mode === "CBC"`。
4. fetch 加密图片为 `ArrayBuffer`。
5. 使用 `crypto.subtle.importKey` 和 `crypto.subtle.decrypt({ name: "AES-CBC", iv })` 解密。
6. 将解密结果编码为 base64，生成可通过扩展消息传递的返回值。

后台不写系统文件，不调用下载 API。加密图片响应可能进入浏览器 HTTP 缓存，这是浏览器行为，不是扩展显式文件输出。解密后的图片只存在于内存和内容页面的 `blob:` URL 生命周期中。

## 5. 消息协议

推荐新增消息：

```js
{
  message: "heiliao.decryptImage",
  url: "https://pic.uforxk.cn/upload_01/a.jpeg"
}
```

成功响应：

```js
{
  message: "heiliao.decryptedImage",
  mime: "image/jpeg",
  base64: "..."
}
```

Chrome 扩展消息使用 JSON 序列化，直接传 `ArrayBuffer` 不够稳妥。因此后台用 base64 承载解密后的图片字节，内容脚本收到后再创建 `Blob` 和 `blob:` URL。

失败响应：

```js
{
  error: "..."
}
```

`messages.js` 只负责路由，不承载具体解密实现。

## 6. DOM 状态约定

使用 `data-heiliao-encrypted-image` 作为内部状态属性。

| 状态 | 含义 |
| --- | --- |
| `pending` | 已识别为 Heiliao 加密图片，等待后台解密 |
| `loading` | 已发起后台解密请求 |
| `loaded` | 已成功替换为本地 `blob:` URL |
| `error` | 解密失败，保持破图表现 |

辅助属性：

| 属性 | 含义 |
| --- | --- |
| `data-heiliao-encrypted-image-src` | 原始加密图片 URL |
| `data-heiliao-encrypted-image-error` | 失败时的内部调试信息 |

这些属性均为扩展内部实现细节，不作为用户可见 UI。

## 7. 错误行为

解密失败时：

1. 保持 `src="about:invalid#heiliao-encrypted-image"`。
2. 保留原始 `alt`。
3. 设置 `data-heiliao-encrypted-image="error"`。
4. 设置 `data-heiliao-encrypted-image-error` 便于调试。
5. 使用 `console.warn` 输出错误。
6. 不设置 `title`。
7. 不向 Markdown 正文插入错误提示、按钮或占位卡片。

这样失败体验接近普通图片加载失败，同时开发调试仍有可追踪状态。

## 8. 缓存策略

### 8.1 Config 缓存

后台维护内存级缓存：

```js
var paramsCache = null
var paramsPromise = null
```

行为：

- 首次解密请求拉取 config。
- 并发首次请求复用 `paramsPromise`。
- 解析成功后写入 `paramsCache`。
- 后续 Markdown 页面复用 `paramsCache`。
- MV3 service worker 被挂起后缓存可能丢失，下次唤醒重新拉取。

不使用 `chrome.storage.session`，不持久化 key/iv。

### 8.2 图片缓存

不跨页面缓存解密后的图片字节，避免大图长期占用内存。

同一页面内可维护：

```js
var pendingImages = {}
var objectUrls = {}
var generation = 0
```

行为：

- `pendingImages` 用于相同 URL 的 Promise 去重。
- `objectUrls` 用于复用同 URL 已创建的 `blob:` URL，避免重复 `base64 -> Blob -> URL.createObjectURL`。
- `generation` 用于标记当前渲染轮次。页面重新渲染、切 raw 或卸载时递增，旧异步请求返回后如果轮次不一致，则丢弃结果。
- 页面重新渲染或卸载时，释放已创建的 `blob:` URL。

## 9. 权限设计

Chrome manifest 推荐：

```json
{
  "host_permissions": [
    "file:///*",
    "*://www.javbus.com/*",
    "https://heiliao.com/*",
    "https://pic.uforxk.cn/*"
  ]
}
```

Firefox manifest 需按当前 manifest 结构加入对应域名权限。

权限范围只覆盖 config 来源和图片来源，不使用更宽泛的 Heiliao 相关域名。

## 10. 安全与兼容性

安全约束：

- 后台必须校验待解密图片 URL 的 hostname。
- 不从远程加载脚本；只 fetch config 文本并解析字段。
- 不把解密 key/iv 写入持久化存储。
- 不将解密后的图片写入系统文件。

兼容性注意：

- WebCrypto `crypto.subtle` 需要安全上下文。扩展后台和扩展内容环境满足该要求。
- Service worker 内存缓存不保证长期存在。
- 若 Heiliao config 结构变化，解析可能失败，此时图片保持破图状态。
- 若未来 config 版本必须由页面上下文决定，需要再补充 config URL 发现机制。

## 11. 测试建议

手工验证：

1. Markdown 中普通图片仍按原逻辑渲染。
2. Markdown 中 `pic.uforxk.cn` 图片预处理后先显示破图。
3. 后台只在首次解密时请求一次 config。
4. 多张 Heiliao 图片能依次替换为真实图片。
5. 相同 URL 的多张图片在同一页面内不会重复解密。
6. 解密失败时保留原始 `alt`，不出现 title、不插入错误 UI。
7. 页面重新渲染或刷新后旧 `blob:` URL 被回收。
8. Chrome 和 Firefox manifest 权限均可支持后台 fetch。

开发验证：

- 对 config 解析函数做最小单元测试。
- 对 hostname 判断和 HTML 预处理函数做纯函数测试。
- 用一份本地 Markdown 样例做扩展冒烟测试。

## 12. 后续可选增强

当前版本不实现以下能力：

- 持久化缓存 Heiliao config。
- 跨页面缓存解密后的图片字节。
- 解密失败重试按钮。
- 正文内错误提示 UI。
- 自动发现带版本的 `app.config.js?v=...`。
- 为 pending 图片预留尺寸占位。

如后续需要，可在不改变核心消息协议的基础上增量加入。
