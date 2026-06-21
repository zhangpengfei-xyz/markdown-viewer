# Heiliao 加密图片解密参考

本文记录一次对 Heiliao 图片加载链路的观察结果，并整理可复用的浏览器端解密方法。它的定位是技术参考，不是最终特性设计；Markdown Viewer 的具体集成方案见 `docs/heiliao-encrypted-image-rendering-design.md`。

本参考关注的目标很窄：

- 找到页面中真实的加密图片 URL。
- 动态获取当前图片解密所需的 AES 参数。
- 不调用源页面里的业务函数，独立完成图片字节解密。
- 验证解密结果是否可以被浏览器作为普通图片渲染。

## 1. 分析来源

最初用于从 `blob:` 图片反查原始加密资源的页面：

```text
https://heiliao.com/archives/104962/
```

该页面中观察到的一张已渲染图片：

```text
blob:https://heiliao.com/1690243b-0315-4555-9bdc-674f1f99cffd
```

同一个 `<img>` 元素上的 `z-image-loader-url` 和 `data-image-zoom` 都指向真实加密资源：

```text
https://pic.uforxk.cn/upload_01/xiao/20260619/2026061921143960009.jpeg
```

页面加载了以下与图片解密相关的静态脚本：

```text
https://heiliao.com/static/v4/__base/config/app.config.js?v=20260620a
https://heiliao.com/static/v4/__base/js/crypto.js?v=20260620a
https://heiliao.com/static/v4/__base/directives/ImageParser.js?v=20260620a
https://heiliao.com/static/v4/__base/js/imagejx.js?v=20260620a
https://heiliao.com/static/v4/__base/js/player.js?v=20260620a
```

额外抽查过其他详情页，用于确认媒体 key 和 IV 是否随页面变化。抽查页面加载的是相同版本的静态 config，解码后的媒体参数也相同。因此这些参数应视为“config 版本范围内稳定”，不应视为永久常量。

## 2. 页面实际行为

Heiliao 页面并不直接把 `pic.uforxk.cn` 资源作为最终图片展示。它会先下载加密图片，解密后创建本地 `blob:` URL，再把 `blob:` URL 设置为 `<img src>`。

观察到的 DOM 形态：

```html
<img
  src="blob:https://heiliao.com/1690243b-0315-4555-9bdc-674f1f99cffd"
  z-image-loader-url="https://pic.uforxk.cn/upload_01/xiao/20260619/2026061921143960009.jpeg"
  data-image-zoom="https://pic.uforxk.cn/upload_01/xiao/20260619/2026061921143960009.jpeg"
  data-image-preview="1"
  load="success">
```

这里的 `blob:` URL 不是远程原图地址。它是当前浏览器进程内的临时对象 URL，只在页面运行时有意义。真正可重新拉取的远程资源是 `z-image-loader-url` 或 `data-image-zoom` 中的 `https://pic.uforxk.cn/...` 地址。

在已渲染的 Heiliao 页面中，可以用下面的代码收集加密图片 URL：

```js
const imageUrls = [...new Set(
  [...document.querySelectorAll('img[z-image-loader-url], img[data-image-zoom]')]
    .map((img) => img.getAttribute('z-image-loader-url') || img.getAttribute('data-image-zoom'))
    .filter(Boolean)
)]
```

## 3. 解密参数来源

抽查页面均加载了同一个 config 脚本：

```text
https://heiliao.com/static/v4/__base/config/app.config.js?v=20260620a
```

图片解密参数位于 `__APP_CONFIG__.crypto`：

```js
crypto: {
  mode: "CBC",
  padding: "Pkcs7",
  media_key: "102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48",
  media_iv: "57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49",
  key: "50_97_99_102_55_101_57_49_101_57_56_54_52_54_55_51",
  iv: "49_99_50_57_56_56_50_100_51_100_100_102_99_102_100_54",
}
```

其中 `media_key` 和 `media_iv` 用于图片解密。字段值是用 `_` 拼接的 ASCII 编码数字：

```js
function decodeAsciiNumbers(value) {
  return value.split('_').map((code) => String.fromCharCode(Number(code))).join('')
}

decodeAsciiNumbers('102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48')
// f5d965df75336270

decodeAsciiNumbers('57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49')
// 97b60394abc2fbe1
```

源页面的 `crypto.js` 使用这些字段完成图片解密，核心逻辑可概括为：

```js
const cryptodata = __APP_CONFIG__.crypto

function DecryptImage(word) {
  const decrypt = CryptoJS.AES.decrypt(word, cc(cryptodata.media_key), {
    iv: cc(cryptodata.media_iv),
    mode: CryptoJS.mode[cryptodata.mode],
    padding: CryptoJS.pad.NoPadding
  })
  return decrypt.toString(CryptoJS.enc.Base64)
}
```

页面图片加载器的大致链路：

```text
加密图片 URL
  -> fetch / axios 获取 arraybuffer
  -> 转为 base64
  -> AES-CBC 解密
  -> 还原图片 bytes
  -> Blob
  -> URL.createObjectURL(blob)
```

`imagejx.js` 的 worker 路径中也包含同一组媒体 key/iv。对 Markdown Viewer 来说，`app.config.js` 更适合作为参数来源，因为它结构集中，便于后台 fetch 后直接解析。

## 4. Padding 说明

源页面在图片解密函数中使用 `CryptoJS.pad.NoPadding`，但 config 中的 `padding` 字段为 `"Pkcs7"`。在验证样本中：

```text
encryptedSize: 152240
decryptedSize: 152230
magic: ffd8ffe000104a464946000101000001
```

WebCrypto 的 AES-CBC 解密返回了 `152230` 字节，并得到有效 JPEG 头。这个现象说明加密载荷末尾存在可识别的块填充，WebCrypto 解密时移除了有效的 PKCS#7 padding。

如果目标是与源页面输出保持严格字节级一致，需要再验证 CryptoJS `NoPadding` 路径是否保留尾部 padding 字节。如果目标是得到可渲染、干净的图片字节，则 WebCrypto AES-CBC 更适合 Markdown Viewer：它不需要引入 CryptoJS，也能直接得到浏览器可识别的 JPEG 数据。

## 5. 独立浏览器验证实现

下面的函数用于普通安全网页里的独立验证。它不调用源页面的 `$CryptoData`、`DecryptImage` 或其他业务函数。

注意：这个示例包含 `<script src="...app.config.js">` fallback，仅用于普通网页调试。MV3 扩展页面和 service worker 受扩展 CSP 限制，不能加载远程脚本；Markdown Viewer 集成时应使用后台 fetch config 文本并解析字段。

```js
async function decryptAndDownloadEncryptedImage({ imageUrl, configUrl, outputName }) {
  function decodeAsciiNumbers(value) {
    if (typeof value !== 'string' || !/^\d+(?:_\d+)+$/.test(value)) {
      throw new Error('invalid encoded crypto field')
    }
    return value.split('_').map((code) => String.fromCharCode(Number(code))).join('')
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = url
      script.async = true
      script.onload = resolve
      script.onerror = () => reject(new Error(`failed to load config script: ${url}`))
      document.head.appendChild(script)
    })
  }

  async function getImageCryptoParams(configUrl) {
    try {
      const text = await fetch(configUrl, { credentials: 'omit' }).then((response) => {
        if (!response.ok) throw new Error(`config fetch failed: ${response.status}`)
        return response.text()
      })

      const mediaKeyRaw = text.match(/media_key:\s*["']([\d_]+)["']/)?.[1]
      const mediaIvRaw = text.match(/media_iv:\s*["']([\d_]+)["']/)?.[1]
      const mode = text.match(/mode:\s*["']([^"']+)["']/)?.[1] || 'CBC'

      if (!mediaKeyRaw || !mediaIvRaw) {
        throw new Error('crypto fields not found in config text')
      }

      return {
        source: 'fetch-parse',
        key: decodeAsciiNumbers(mediaKeyRaw),
        iv: decodeAsciiNumbers(mediaIvRaw),
        mode,
      }
    } catch (fetchError) {
      await loadScript(configUrl)

      const cryptoConfig = globalThis.__APP_CONFIG__?.crypto
      if (!cryptoConfig?.media_key || !cryptoConfig?.media_iv) {
        throw new Error(`crypto config unavailable after script load: ${fetchError.message}`)
      }

      return {
        source: 'script-config',
        key: decodeAsciiNumbers(cryptoConfig.media_key),
        iv: decodeAsciiNumbers(cryptoConfig.media_iv),
        mode: cryptoConfig.mode || 'CBC',
      }
    }
  }

  const params = await getImageCryptoParams(configUrl)
  if (params.mode !== 'CBC') {
    throw new Error(`unsupported media crypto mode: ${params.mode}`)
  }

  const encoder = new TextEncoder()
  const keyBytes = encoder.encode(params.key)
  const ivBytes = encoder.encode(params.iv)

  const response = await fetch(imageUrl, { mode: 'cors', credentials: 'omit' })
  if (!response.ok) {
    throw new Error(`image fetch failed: ${response.status} ${response.statusText}`)
  }

  const encryptedBytes = new Uint8Array(await response.arrayBuffer())
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'])
  const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, aesKey, encryptedBytes)
  const decryptedBytes = new Uint8Array(decryptedBuffer)

  const blob = new Blob([decryptedBytes], { type: 'image/jpeg' })
  const blobUrl = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = blobUrl
  link.download = outputName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl)
    link.remove()
  }, 30000)

  return {
    paramSource: params.source,
    key: params.key,
    iv: params.iv,
    mode: params.mode,
    encryptedSize: encryptedBytes.byteLength,
    decryptedSize: decryptedBytes.byteLength,
    looksLikeJpeg: decryptedBytes[0] === 0xff && decryptedBytes[1] === 0xd8,
  }
}
```

调用示例：

```js
await decryptAndDownloadEncryptedImage({
  configUrl: 'https://heiliao.com/static/v4/__base/config/app.config.js?v=20260620a',
  imageUrl: 'https://pic.uforxk.cn/upload_01/xiao/20260619/2026061921143960009.jpeg',
  outputName: '2026061921143960009.decrypted.jpeg',
})
```

验证输出是一张有效 JPEG/JFIF 图片，尺寸为 `498x1080`，解密后大小为 `152230` 字节。

## 6. 安全上下文说明

`crypto.subtle` 只在安全上下文中可用。通过 CDP 创建的顶层 `about:blank` 页面不一定有可信 origin，因此可能出现 `crypto.subtle === undefined`。

适合运行 WebCrypto 解密的上下文：

- `https://...`
- `http://localhost/...`
- `http://127.0.0.1/...`
- `chrome-extension://<extension-id>/...`

可以用下面的代码检查当前上下文：

```js
console.log({
  href: location.href,
  origin: location.origin,
  isSecureContext,
  hasSubtle: !!globalThis.crypto?.subtle,
})
```

`file://` 在不少 Chrome 构建中也可能是安全上下文，但它的 origin 和 CORS 行为不够稳定，不建议作为解密逻辑的主要运行环境。

## 7. CORS 与扩展权限

CORS 决定页面脚本是否可以读取跨域响应体。

这些标签可以跨域加载资源，但不会把响应字节暴露给页面脚本：

```html
<img src="https://example.com/a.jpg">
<script src="https://example.com/a.js"></script>
```

而下面的代码必须得到目标服务器 CORS 允许，才能读取响应体：

```js
await fetch('https://example.com/a.jpg').then((response) => response.arrayBuffer())
```

`fetch(url, { mode: 'no-cors' })` 对解密没有帮助，因为它返回 opaque response，脚本不能读取 body。

普通空白页验证时观察到：

- 直接 `fetch(configUrl).text()` 不是稳定路径，可能受 CORS 限制。
- 用经典 `<script>` 加载 `app.config.js` 可以暴露 `window.__APP_CONFIG__`。
- 直接 `fetch(imageUrl).arrayBuffer()` 对测试图片主机可用。

Markdown Viewer 是扩展环境，推荐使用后台 service worker 搭配 host permissions 拉取 config 和图片。这样不需要依赖页面 CORS，也不需要远程 `<script>` fallback。

## 8. Markdown Viewer 集成要点

Markdown Viewer 的集成应采用后台解密服务，而不是在内容页面加载 Heiliao 脚本。

推荐流程：

1. 内容脚本识别 Markdown 渲染结果中的 `pic.uforxk.cn` 图片。
2. 内容脚本向后台发送待解密图片 URL。
3. 后台 fetch config 文本并解析 `media_key` / `media_iv`。
4. 后台 fetch 加密图片字节并使用 WebCrypto AES-CBC 解密。
5. 后台通过扩展消息返回解密后的 base64 字符串和 MIME。
6. 内容脚本将 base64 还原为 `Blob`，创建 `blob:` URL，替换 `<img src>`。

当前特性设计中选择固定窄域名权限：

```json
{
  "host_permissions": [
    "https://heiliao.com/*",
    "https://pic.uforxk.cn/*"
  ]
}
```

重要约束：

- 扩展页面和 MV3 service worker 不能通过 `<script src="https://...">` 加载远程脚本。
- 后台应 fetch config 文本并用正则或结构化解析提取字段。
- 后台应校验待解密图片 hostname 必须是 `pic.uforxk.cn`。
- 解密 key/iv 不应写入持久化存储。

后台解析 config 的核心函数可简化为：

```js
async function getImageCryptoParamsFromConfig(configUrl) {
  const text = await fetch(configUrl, { credentials: 'omit' }).then((response) => {
    if (!response.ok) throw new Error(`config fetch failed: ${response.status}`)
    return response.text()
  })

  const decodeAsciiNumbers = (value) =>
    value.split('_').map((code) => String.fromCharCode(Number(code))).join('')

  const mediaKeyRaw = text.match(/media_key:\s*["']([\d_]+)["']/)?.[1]
  const mediaIvRaw = text.match(/media_iv:\s*["']([\d_]+)["']/)?.[1]
  const mode = text.match(/mode:\s*["']([^"']+)["']/)?.[1] || 'CBC'

  if (!mediaKeyRaw || !mediaIvRaw) {
    throw new Error('media crypto fields not found')
  }

  return {
    key: decodeAsciiNumbers(mediaKeyRaw),
    iv: decodeAsciiNumbers(mediaIvRaw),
    mode,
  }
}
```

如果解密发生在 service worker 中，那里没有 DOM，不能直接创建下载链接或操作页面图片。Markdown Viewer 的渲染场景不需要下载文件，推荐让后台返回可通过扩展消息稳定传递的 base64 字符串，由内容脚本还原为 `Blob`、创建 `blob:` URL 并更新 DOM。

## 9. 验证记录

独立空白页验证使用的参数：

```text
configUrl: https://heiliao.com/static/v4/__base/config/app.config.js?v=20260620a
imageUrl:  https://pic.uforxk.cn/upload_01/xiao/20260619/2026061921143960009.jpeg
```

验证结果：

```text
paramSource: script-config
key: f5d965df75336270
iv: 97b60394abc2fbe1
mode: CBC
encryptedSize: 152240
decryptedSize: 152230
magic: ffd8ffe000104a464946000101000001
looksLikeJpeg: true
file: JPEG image data, JFIF standard 1.01, 498x1080
```

同一测试在另一个 Chrome 调试实例中重复执行，得到相同的解密 JPEG。

## 10. 实用建议

- 不要把解码后的 key/iv 写死为常量，应从当前 config 解析。
- `app.config.js?v=...` 应视为版本化远程配置，未来版本可能轮换媒体参数。
- Markdown Viewer 当前集成设计使用不带版本的 `https://heiliao.com/static/v4/__base/config/app.config.js`，由后台内存缓存解析结果。
- 优先在扩展后台中 fetch config 和加密图片，避免内容脚本受 CORS 限制。
- 优先使用 WebCrypto，不额外引入 CryptoJS。
- `blob:` URL 只是本地临时渲染地址，不代表远程原图。
- 解密后的图片不需要写入系统文件；渲染完成后应在合适时机回收 `blob:` URL。
- 调试时应区分 config 拉取失败、图片拉取失败、参数解析失败和 WebCrypto 解密失败。
