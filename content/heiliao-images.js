
var heiliaoImages = (() => {
  var imageHost = 'pic.uforxk.cn'
  var brokenImageSrc = 'about:invalid#heiliao-encrypted-image'
  var objectUrls = {}
  var pendingImages = {}
  var generation = 0

  var preprocess = (html) => {
    if (!/<img[\s>]/i.test(html) || html.indexOf(imageHost) === -1) {
      return html
    }

    var doc = new DOMParser().parseFromString(html, 'text/html')

    Array.from(doc.querySelectorAll('img[src]')).forEach((img) => {
      var url
      try {
        url = new URL(img.getAttribute('src'), document.baseURI)
      }
      catch (err) {
        return
      }

      if (url.hostname !== imageHost) {
        return
      }

      img.setAttribute('data-heiliao-encrypted-image', 'pending')
      img.setAttribute('data-heiliao-encrypted-image-src', url.href)
      img.setAttribute('src', brokenImageSrc)
    })

    return doc.body.innerHTML
  }

  var render = () => {
    Array.from(document.querySelectorAll('img[data-heiliao-encrypted-image="pending"]'))
      .forEach(load)
  }

  var reset = () => {
    generation++
    Object.keys(objectUrls).forEach((url) => URL.revokeObjectURL(objectUrls[url]))
    objectUrls = {}
    pendingImages = {}
  }

  var load = (img) => {
    var imageUrl = img.getAttribute('data-heiliao-encrypted-image-src')
    var currentGeneration = generation
    if (!imageUrl) {
      fail(img, new Error('missing encrypted image URL'))
      return
    }

    img.setAttribute('data-heiliao-encrypted-image', 'loading')

    decrypt(imageUrl).then((res) => {
      if (currentGeneration !== generation || !document.contains(img)) {
        return
      }

      var objectUrl = objectUrls[imageUrl]
      if (!objectUrl) {
        objectUrl = URL.createObjectURL(base64ToBlob(res.base64, res.mime))
        objectUrls[imageUrl] = objectUrl
      }

      img.src = objectUrl
      img.setAttribute('data-heiliao-encrypted-image', 'loaded')
      img.removeAttribute('data-heiliao-encrypted-image-error')
    }).catch((err) => {
      if (currentGeneration === generation) {
        fail(img, err)
      }
    })
  }

  var decrypt = (imageUrl) => {
    if (!pendingImages[imageUrl]) {
      var currentPendingImages = pendingImages
      pendingImages[imageUrl] = new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          message: 'heiliao.decryptImage',
          url: imageUrl,
        }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          }
          else if (!res || res.error) {
            reject(new Error(res && res.error || 'image decrypt failed'))
          }
          else {
            resolve(res)
          }
        })
      }).finally(() => {
        delete currentPendingImages[imageUrl]
      })
    }

    return pendingImages[imageUrl]
  }

  var fail = (img, err) => {
    if (document.contains(img)) {
      img.setAttribute('data-heiliao-encrypted-image', 'error')
      img.setAttribute('data-heiliao-encrypted-image-error', err.message || String(err))
      img.src = brokenImageSrc
    }
    console.warn('Heiliao image decrypt failed:', err)
  }

  var base64ToBlob = (base64, mime) => {
    var binary = atob(base64)
    var bytes = []
    var chunk = 0x8000

    for (var index = 0; index < binary.length; index += chunk) {
      var slice = binary.slice(index, index + chunk)
      var array = new Uint8Array(slice.length)
      for (var offset = 0; offset < slice.length; offset++) {
        array[offset] = slice.charCodeAt(offset)
      }
      bytes.push(array)
    }

    return new Blob(bytes, {type: mime || 'application/octet-stream'})
  }

  window.addEventListener('beforeunload', reset)

  return {preprocess, render, reset}
})()
