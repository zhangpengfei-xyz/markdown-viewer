
md.heiliaoImages = () => {
  var configUrl = 'https://heiliao.com/static/v4/__base/config/app.config.js'
  var imageHost = 'pic.uforxk.cn'

  var paramsCache = null
  var paramsPromise = null

  var decrypt = async (imageUrl) => {
    var url = new URL(imageUrl)
    if (url.protocol !== 'https:' || url.hostname !== imageHost) {
      throw new Error('unsupported Heiliao image URL')
    }
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('WebCrypto is unavailable')
    }

    var params = await getParams()
    if (String(params.mode).toUpperCase() !== 'CBC') {
      throw new Error(`unsupported media crypto mode: ${params.mode}`)
    }

    var response = await fetch(url.href, {credentials: 'omit'})
    if (!response.ok) {
      throw new Error(`image fetch failed: ${response.status} ${response.statusText}`)
    }

    var encryptedBytes = new Uint8Array(await response.arrayBuffer())
    var encoder = new TextEncoder()
    var keyBytes = encoder.encode(params.key)
    var ivBytes = encoder.encode(params.iv)
    var aesKey = await crypto.subtle.importKey('raw', keyBytes, {name: 'AES-CBC'}, false, ['decrypt'])
    var decryptedBuffer = await crypto.subtle.decrypt({name: 'AES-CBC', iv: ivBytes}, aesKey, encryptedBytes)
    var decryptedBytes = new Uint8Array(decryptedBuffer)

    return {
      mime: detectMime(decryptedBytes) || normalizeImageType(response.headers.get('content-type')) || 'image/jpeg',
      base64: bytesToBase64(decryptedBytes),
    }
  }

  var getParams = async () => {
    if (paramsCache) {
      return paramsCache
    }
    if (!paramsPromise) {
      paramsPromise = fetchParams()
    }

    try {
      paramsCache = await paramsPromise
      return paramsCache
    }
    catch (err) {
      paramsPromise = null
      throw err
    }
  }

  var fetchParams = async () => {
    var response = await fetch(configUrl, {credentials: 'omit'})
    if (!response.ok) {
      throw new Error(`config fetch failed: ${response.status} ${response.statusText}`)
    }

    var text = await response.text()
    var mediaKeyRaw = text.match(/media_key:\s*["']([\d_]+)["']/)?.[1]
    var mediaIvRaw = text.match(/media_iv:\s*["']([\d_]+)["']/)?.[1]
    var mode = text.match(/mode:\s*["']([^"']+)["']/)?.[1] || 'CBC'

    if (!mediaKeyRaw || !mediaIvRaw) {
      throw new Error('media crypto fields not found')
    }

    return {
      key: decodeAsciiNumbers(mediaKeyRaw),
      iv: decodeAsciiNumbers(mediaIvRaw),
      mode,
    }
  }

  var decodeAsciiNumbers = (value) => {
    if (typeof value !== 'string' || !/^\d+(?:_\d+)+$/.test(value)) {
      throw new Error('invalid encoded crypto field')
    }
    return value.split('_').map((code) => {
      var number = Number(code)
      if (!Number.isInteger(number) || number < 0 || number > 255) {
        throw new Error('invalid encoded crypto field')
      }
      return String.fromCharCode(number)
    }).join('')
  }

  var detectMime = (bytes) => {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg'
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png'
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return 'image/gif'
    }
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
  }

  var normalizeImageType = (contentType) =>
    /^image\//i.test(contentType || '') ? contentType.split(';')[0].trim() : ''

  var bytesToBase64 = (bytes) => {
    var binary = ''
    var chunk = 0x8000
    for (var index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
    }
    return btoa(binary)
  }

  return {decrypt}
}
