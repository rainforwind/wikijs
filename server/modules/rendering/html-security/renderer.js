const { JSDOM } = require('jsdom')
const createDOMPurify = require('dompurify')

module.exports = {
  async init(input, config) {
    if (config.safeHTML) {
      const window = new JSDOM('').window
      const DOMPurify = createDOMPurify(window)

      const allowedAttrs = ['v-pre', 'v-slot:tabs', 'v-slot:content', 'target']
      const allowedTags = ['tabset', 'template']

      if (config.allowDrawIoUnsafe) {
        allowedTags.push('foreignObject')
        DOMPurify.addHook('uponSanitizeElement', (elm) => {
          if (elm.querySelectorAll) {
            const breaks = elm.querySelectorAll('foreignObject br, foreignObject p')
            if (breaks && breaks.length) {
              for (let i = 0; i < breaks.length; i++) {
                breaks[i].parentNode.replaceChild(
                  window.document.createElement('div'),
                  breaks[i]
                )
              }
            }
          }
        })
      }

      if (config.allowIFrames) {
        allowedTags.push('iframe')
        allowedAttrs.push('allow')
      }

      if (config.allowUnsafeHTML) {
        // Allow <script>, <style>, <link> for HTML slides (reveal.js, etc.)
        // and embedded interactive content
        allowedTags.push('script', 'style', 'link')
        allowedAttrs.push('type', 'src', 'charset', 'async', 'defer', 'integrity',
          'crossorigin', 'nomodule', 'nonce', 'media', 'rel', 'href', 'as')
      }

      input = DOMPurify.sanitize(input, {
        ADD_ATTR: allowedAttrs,
        ADD_TAGS: allowedTags,
        HTML_INTEGRATION_POINTS: { foreignobject: true }
      })
    }
    return input
  }
}
