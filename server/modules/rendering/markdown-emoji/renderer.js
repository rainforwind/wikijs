const { full: mdEmoji } = require('markdown-it-emoji')

// ------------------------------------
// Markdown - Emoji
// ------------------------------------

module.exports = {
  init (md, conf) {
    md.use(mdEmoji)

    // Use native Unicode emoji (all modern OS/Browser support them)
    // Previously used twemoji to render as SVG images for cross-platform consistency
    // but this is no longer necessary and saves 7.3MB of bundled assets
    md.renderer.rules.emoji = (token, idx) => {
      return token[idx].content
    }
  }
}
