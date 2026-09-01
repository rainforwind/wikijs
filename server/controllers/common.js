const express = require('express')
const router = express.Router()
const pageHelper = require('../helpers/page')
const _ = require('lodash')
const CleanCSS = require('clean-css')
const moment = require('moment')
const qs = require('querystring')

/* global WIKI */

const tmplCreateRegex = /^[0-9]+(,[0-9]+)?$/

/**
 * Robots.txt
 */
router.get('/robots.txt', (req, res, next) => {
  res.type('text/plain')
  if (_.includes(WIKI.config.seo.robots, 'noindex')) {
    res.send('User-agent: *\nDisallow: /')
  } else {
    res.status(200).end()
  }
})

/**
 * Health Endpoint
 */
router.get('/healthz', (req, res, next) => {
  if (WIKI.models.knex.client.pool.numFree() < 1 && WIKI.models.knex.client.pool.numUsed() < 1) {
    res.status(503).json({ ok: false }).end()
  } else {
    res.status(200).json({ ok: true }).end()
  }
})

/**
 * Administration
 */
router.get(['/a', '/a/*'], (req, res, next) => {
  if (!WIKI.auth.checkAccess(req.user, [
    'manage:system',
    'write:users',
    'manage:users',
    'write:groups',
    'manage:groups',
    'manage:navigation',
    'manage:theme',
    'manage:api'
  ])) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  _.set(res.locals, 'pageMeta.title', 'Admin')
  res.render('admin')
})

/**
 * Download Page / Version
 */
router.get(['/d', '/d/*'], async (req, res, next) => {
  const pageArgs = pageHelper.parsePath(req.path, { stripExt: true })

  const versionId = (req.query.v) ? _.toSafeInteger(req.query.v) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: req.user.id,
    isPrivate: false
  })

  pageArgs.tags = _.get(page, 'tags', [])

  if (versionId > 0) {
    if (!WIKI.auth.checkAccess(req.user, ['read:history'], pageArgs)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'downloadVersion' })
    }
  } else {
    if (!WIKI.auth.checkAccess(req.user, ['read:source'], pageArgs)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'download' })
    }
  }

  if (page) {
    const fileName = _.last(page.path.split('/')) + '.' + pageHelper.getFileExtension(page.contentType)
    res.attachment(fileName)
    if (versionId > 0) {
      const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: page.id, versionId })
      res.send(pageHelper.injectPageMetadata(pageVersion))
    } else {
      res.send(pageHelper.injectPageMetadata(page))
    }
  } else {
    res.status(404).end()
  }
})

/**
 * Create/Edit document
 */
router.get(['/e', '/e/*'], async (req, res, next) => {
  const pageArgs = pageHelper.parsePath(req.path, { stripExt: true })

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/e/${pageArgs.locale}/${pageArgs.path}`)
  }

  req.i18n.changeLanguage(pageArgs.locale)

  // -> Set Editor Lang
  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', req.i18n.dir() === 'rtl')

  // -> Check for reserved path
  if (pageHelper.isReservedPath(pageArgs.path)) {
    return next(new Error('Cannot create this page because it starts with a system reserved path.'))
  }

  // -> Get page data from DB
  let page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: req.user.id,
    isPrivate: false
  })

  pageArgs.tags = _.get(page, 'tags', [])

  // -> Effective Permissions
  const effectivePermissions = WIKI.auth.getEffectivePermissions(req, pageArgs)

  const injectCode = {
    css: WIKI.config.theming.injectCSS,
    head: WIKI.config.theming.injectHead,
    body: WIKI.config.theming.injectBody
  }

  if (page) {
    // -> EDIT MODE
    if (!(effectivePermissions.pages.write || effectivePermissions.pages.manage)) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'edit' })
    }

    // -> Get page tags
    await page.$relatedQuery('tags')
    page.tags = _.map(page.tags, 'tag')

    // Handle missing extra field
    page.extra = page.extra || { css: '', js: '' }

    // -> Beautify Script CSS
    if (!_.isEmpty(page.extra.css)) {
      page.extra.css = new CleanCSS({ format: 'beautify' }).minify(page.extra.css).styles
    }

    _.set(res.locals, 'pageMeta.title', `Edit ${page.title}`)
    _.set(res.locals, 'pageMeta.description', page.description)
    page.mode = 'update'
    page.isPublished = (page.isPublished === true || page.isPublished === 1) ? 'true' : 'false'
    page.content = Buffer.from(page.content).toString('base64')
  } else {
    // -> CREATE MODE
    if (!effectivePermissions.pages.write) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'create' })
    }

    _.set(res.locals, 'pageMeta.title', `New Page`)
    page = {
      path: pageArgs.path,
      localeCode: pageArgs.locale,
      editorKey: null,
      mode: 'create',
      content: null,
      title: null,
      description: null,
      updatedAt: new Date().toISOString(),
      extra: {
        css: '',
        js: ''
      }
    }

    // -> From Template
    if (req.query.from && tmplCreateRegex.test(req.query.from)) {
      let tmplPageId = 0
      let tmplVersionId = 0
      if (req.query.from.indexOf(',')) {
        const q = req.query.from.split(',')
        tmplPageId = _.toSafeInteger(q[0])
        tmplVersionId = _.toSafeInteger(q[1])
      } else {
        tmplPageId = _.toSafeInteger(req.query.from)
      }

      if (tmplVersionId > 0) {
        // -> From Page Version
        const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: tmplPageId, versionId: tmplVersionId })
        if (!pageVersion) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        if (!WIKI.auth.checkAccess(req.user, ['read:history'], { path: pageVersion.path, locale: pageVersion.locale })) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', { action: 'sourceVersion' })
        }
        page.content = Buffer.from(pageVersion.content).toString('base64')
        page.editorKey = pageVersion.editor
        page.title = pageVersion.title
        page.description = pageVersion.description
      } else {
        // -> From Page Live
        const pageOriginal = await WIKI.models.pages.query().findById(tmplPageId)
        if (!pageOriginal) {
          _.set(res.locals, 'pageMeta.title', 'Page Not Found')
          return res.status(404).render('notfound', { action: 'template' })
        }
        if (!WIKI.auth.checkAccess(req.user, ['read:source'], { path: pageOriginal.path, locale: pageOriginal.locale })) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', { action: 'source' })
        }
        page.content = Buffer.from(pageOriginal.content).toString('base64')
        page.editorKey = pageOriginal.editorKey
        page.title = pageOriginal.title
        page.description = pageOriginal.description
      }
    }
  }

  res.render('editor', { page, injectCode, effectivePermissions })
})

/**
 * History
 */
router.get(['/h', '/h/*'], async (req, res, next) => {
  const pageArgs = pageHelper.parsePath(req.path, { stripExt: true })

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/h/${pageArgs.locale}/${pageArgs.path}`)
  }

  req.i18n.changeLanguage(pageArgs.locale)

  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', req.i18n.dir() === 'rtl')

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: req.user.id,
    isPrivate: false
  })

  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'history' })
  }

  pageArgs.tags = _.get(page, 'tags', [])

  const effectivePermissions = WIKI.auth.getEffectivePermissions(req, pageArgs)

  if (!effectivePermissions.history.read) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.render('unauthorized', { action: 'history' })
  }

  if (page) {
    _.set(res.locals, 'pageMeta.title', page.title)
    _.set(res.locals, 'pageMeta.description', page.description)

    res.render('history', { page, effectivePermissions })
  } else {
    res.redirect(`/${pageArgs.path}`)
  }
})

/**
 * Page ID redirection
 */
router.get(['/i', '/i/:id'], async (req, res, next) => {
  const pageId = _.toSafeInteger(req.params.id)
  if (pageId <= 0) {
    return res.redirect('/')
  }

  const page = await WIKI.models.pages.query().column(['path', 'localeCode', 'isPrivate', 'privateNS']).findById(pageId)
  if (!page) {
    _.set(res.locals, 'pageMeta.title', 'Page Not Found')
    return res.status(404).render('notfound', { action: 'view' })
  }

  if (!WIKI.auth.checkAccess(req.user, ['read:pages'], {
    locale: page.localeCode,
    path: page.path,
    private: page.isPrivate,
    privateNS: page.privateNS,
    explicitLocale: false,
    tags: page.tags
  })) {
    _.set(res.locals, 'pageMeta.title', 'Unauthorized')
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  if (WIKI.config.lang.namespacing) {
    return res.redirect(`/${page.localeCode}/${page.path}`)
  } else {
    return res.redirect(`/${page.path}`)
  }
})

/**
 * Profile
 */
router.get(['/p', '/p/*'], (req, res, next) => {
  if (!req.user || req.user.id < 1 || req.user.id === 2) {
    return res.status(403).render('unauthorized', { action: 'view' })
  }

  _.set(res.locals, 'pageMeta.title', 'User Profile')
  res.render('profile')
})

/**
 * Source
 */
router.get(['/s', '/s/*'], async (req, res, next) => {
  const pageArgs = pageHelper.parsePath(req.path, { stripExt: true })
  const versionId = (req.query.v) ? _.toSafeInteger(req.query.v) : 0

  const page = await WIKI.models.pages.getPageFromDb({
    path: pageArgs.path,
    locale: pageArgs.locale,
    userId: req.user.id,
    isPrivate: false
  })

  pageArgs.tags = _.get(page, 'tags', [])

  if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
    return res.redirect(`/s/${pageArgs.locale}/${pageArgs.path}`)
  }

  // -> Effective Permissions
  const effectivePermissions = WIKI.auth.getEffectivePermissions(req, pageArgs)

  _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
  _.set(res, 'locals.siteConfig.rtl', req.i18n.dir() === 'rtl')

  if (versionId > 0) {
    if (!effectivePermissions.history.read) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'sourceVersion' })
    }
  } else {
    if (!effectivePermissions.source.read) {
      _.set(res.locals, 'pageMeta.title', 'Unauthorized')
      return res.status(403).render('unauthorized', { action: 'source' })
    }
  }

  if (page) {
    if (versionId > 0) {
      const pageVersion = await WIKI.models.pageHistory.getVersion({ pageId: page.id, versionId })
      _.set(res.locals, 'pageMeta.title', pageVersion.title)
      _.set(res.locals, 'pageMeta.description', pageVersion.description)
      res.render('source', {
        page: {
          ...page,
          ...pageVersion
        },
        effectivePermissions
      })
    } else {
      _.set(res.locals, 'pageMeta.title', page.title)
      _.set(res.locals, 'pageMeta.description', page.description)

      res.render('source', { page, effectivePermissions })
    }
  } else {
    res.redirect(`/${pageArgs.path}`)
  }
})

/**
 * Tags
 */
router.get(['/t', '/t/*'], (req, res, next) => {
  _.set(res.locals, 'pageMeta.title', 'Tags')
  res.render('tags')
})

/**
 * User Avatar
 */
router.get('/_userav/:uid', async (req, res, next) => {
  if (!WIKI.auth.checkAccess(req.user, ['read:pages'])) {
    return res.sendStatus(403)
  }
  const av = await WIKI.models.users.getUserAvatarData(req.params.uid)
  if (av) {
    res.set('Content-Type', 'image/jpeg')
    res.send(av)
  }

  return res.sendStatus(404)
})

/**
 * View document / asset
 */
router.get('/*', async (req, res, next) => {
  const stripExt = _.some(WIKI.config.pageExtensions, ext => _.endsWith(req.path, `.${ext}`))
  const pageArgs = pageHelper.parsePath(req.path, { stripExt })
  const isPage = (stripExt || pageArgs.path.indexOf('.') === -1)

  if (isPage) {
    if (WIKI.config.lang.namespacing && !pageArgs.explicitLocale) {
      const query = !_.isEmpty(req.query) ? `?${qs.stringify(req.query)}` : ''
      return res.redirect(`/${pageArgs.locale}/${pageArgs.path}${query}`)
    }

    req.i18n.changeLanguage(pageArgs.locale)

    try {
      // -> Get Page from cache
      const page = await WIKI.models.pages.getPage({
        path: pageArgs.path,
        locale: pageArgs.locale,
        userId: req.user.id,
        isPrivate: false
      })
      pageArgs.tags = _.get(page, 'tags', [])

      // -> Effective Permissions
      const effectivePermissions = WIKI.auth.getEffectivePermissions(req, pageArgs)

      // -> Check User Access
      if (!effectivePermissions.pages.read) {
        if (req.user.id === 2) {
          res.cookie('loginRedirect', req.path, {
            maxAge: 15 * 60 * 1000
          })
        }
        if (pageArgs.path === 'home' && req.user.id === 2) {
          return res.redirect('/login')
        }
        _.set(res.locals, 'pageMeta.title', 'Unauthorized')
        return res.status(403).render('unauthorized', {
          action: 'view'
        })
      }

      _.set(res, 'locals.siteConfig.lang', pageArgs.locale)
      _.set(res, 'locals.siteConfig.rtl', req.i18n.dir() === 'rtl')

      if (page) {
        _.set(res.locals, 'pageMeta.title', page.title)
        _.set(res.locals, 'pageMeta.description', page.description)

        // -> Check Publishing State
        let pageIsPublished = page.isPublished
        if (pageIsPublished && !_.isEmpty(page.publishStartDate)) {
          pageIsPublished = moment(page.publishStartDate).isSameOrBefore()
        }
        if (pageIsPublished && !_.isEmpty(page.publishEndDate)) {
          pageIsPublished = moment(page.publishEndDate).isSameOrAfter()
        }
        if (!pageIsPublished && !effectivePermissions.pages.write) {
          _.set(res.locals, 'pageMeta.title', 'Unauthorized')
          return res.status(403).render('unauthorized', {
            action: 'view'
          })
        }

        // -> Build sidebar navigation
        let sdi = 1
        const sidebar = (await WIKI.models.navigation.getTree({ cache: true, locale: pageArgs.locale, groups: req.user.groups })).map(n => ({
          i: `sdi-${sdi++}`,
          k: n.kind,
          l: n.label,
          c: n.icon,
          y: n.targetType,
          t: n.target
        }))

        // -> Build theme code injection
        const injectCode = {
          css: WIKI.config.theming.injectCSS,
          head: WIKI.config.theming.injectHead,
          body: WIKI.config.theming.injectBody
        }

        // Handle missing extra field
        page.extra = page.extra || { css: '', js: '' }

        if (!_.isEmpty(page.extra.css)) {
          injectCode.css = `${injectCode.css}\n${page.extra.css}`
        }

        if (!_.isEmpty(page.extra.js)) {
          injectCode.body = `${injectCode.body}\n${page.extra.js}`
        }

        // -> Handle <style> tags from page.render (extract to head for reliable loading)
        // NOTE: <script> tags are KEPT in page.render — page.vue executes them
        // sequentially AFTER v-html renders, so .reveal etc. exist by then.
        if (page.render && page.editorKey === 'code') {
          // -> Strip full HTML document wrappers (<!DOCTYPE>, <html>, <head>, <body>)
          // so the inner content renders cleanly inside Wiki.js's own HTML shell.
          const fullDocMatch = page.render.match(/^\s*(?:<!DOCTYPE[^>]*>[\s\S]*?)?<html\b[^>]*>([\s\S]*)<\/html>\s*$/i)
          if (fullDocMatch) {
            const inner = fullDocMatch[1]
            // Extract <head> content (styles, scripts, meta) → move to injectCode
            const headMatch = inner.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)
            if (headMatch) {
              const headContent = headMatch[1]
              // Extract <style> tags from head
              headContent.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
                injectCode.css = `${injectCode.css}\n${css}`
              })
              // Extract <script> tags from head → injectCode.head
              headContent.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, code) => {
                injectCode.head = `${injectCode.head}\n<script${attrs}>${code}</script>`
              })
              // Extract <link rel="stylesheet"> → injectCode.head
              headContent.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (match) => {
                injectCode.head = `${injectCode.head}\n${match}`
              })
            }
            // Extract <body> content
            const bodyMatch = inner.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
            page.render = bodyMatch ? bodyMatch[1] : inner.replace(/<\/?head\b[\s\S]*?>/gi, '').replace(/<\/?body\b[^>]*>/gi, '')
          }
          const extractedStyles = []

          // Extract <style> tags only
          page.render = page.render.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (match) => {
            extractedStyles.push(match)
            return '<!-- [auto-extracted style] -->'
          })

          if (extractedStyles.length > 0) {
            injectCode.css = `${injectCode.css}\n${extractedStyles.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n')}`
          }
        }

                // -> Load page tags for standalone detection (keep original page.tags for Vue template)
        const tagResult = await WIKI.models.knex.raw('SELECT t.tag FROM tags t JOIN "pageTags" pt ON t.id = pt."tagId" WHERE pt."pageId" = ?', [page.id])
        // Normalize to lowercase: tag matching is case-insensitive. All convention
        // tags MUST be lowercase ('standalone', 'pub-exit', 'public', ...); this
        // guards against mixed-case entries (known Footgun).
        const tagNames = tagResult.rows.map(r => String(r.tag).toLowerCase())
        const isStandalone = tagNames.includes('standalone')
        const isPubDomain = req.hostname === 'pub.logicpiece.net'

        // -> Standalone page mode
        if (isStandalone) {
          const pubAllowExit = tagNames.includes('pub-exit')
          if (isPubDomain) {
            // Pub domain. Without `pub-exit`: locked fullscreen, no button.
            // With `pub-exit`: Exit button switches between locked fullscreen
            // (.v-application WITHOUT .standalone-exit) and the normal Wiki.js view
            // (.v-application WITH .standalone-exit, chrome restored via :not()).
            // Build per-selector prefixed rules so each gets its own :not() guard.
            // BUG-FIX: a comma-separated list like `.not-exit A, B, C` only applies
            // :not() to A — B and C are matched unconditionally!
            const chromeSelectors = ['header', '.v-toolbar', 'nav-header', '.v-navigation-drawer', '.page-header-section', '.v-divider', '.page-edit-fab', '.page-edit-shortcuts', '.nav-footer', '.page-toc-card', '.page-tags-card', '.page-comments-card', '.page-author-card', '.page-shortcuts-card', '.page-col-sd', '.comments-container', '#discussion', '.v-footer']
            const hideRule = chromeSelectors.map(s => '.v-application:not(.standalone-exit) ' + s).join(',\n  ') + ' { display: none !important; }'
            const showRule = chromeSelectors.map(s => '.v-application.standalone-exit ' + s).join(',\n  ') + ' { display: block !important; }'
            const stretch = '\n.container, .container--fluid, .layout, .row, .page-col-content, .contents { padding: 0 !important; margin: 0 !important; max-width: 100% !important; width: 100% !important; }\n.page-col-content { flex: 0 0 100% !important; }'
            injectCode.css = `${injectCode.css}\n${hideRule}\n${showRule}${stretch}\n.v-application:not(.standalone-exit) .reveal, .v-application:not(.standalone-exit) .page-col-content > div { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; margin: 0 !important; overflow: hidden !important; }\n/* Generic standalone: make page content fill viewport for any slide system */\n.v-application:not(.standalone-exit) .page-col-content { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; padding: 0 !important; margin: 0 !important; overflow: hidden !important; }\n.v-application:not(.standalone-exit) .contents { padding: 0 !important; margin: 0 !important; overflow: hidden !important; height: 100vh !important; }`
            if (pubAllowExit) {
              // Exit mode layout: show slides as scrollable list; background/color handled by JS
              injectCode.css = `${injectCode.css}\n.v-application.standalone-exit .container, .v-application.standalone-exit .container--fluid { width: 100% !important; max-width: 100% !important; }\n.v-application.standalone-exit .reveal-viewport, .v-application.standalone-exit .reveal { position: relative !important; height: auto !important; overflow: visible !important; }\n.v-application.standalone-exit .reveal .slides { position: static !important; width: auto !important; height: auto !important; transform: none !important; }\n.v-application.standalone-exit .reveal .slides > section { position: static !important; display: flow-root !important; width: auto !important; height: auto !important; transform: none !important; opacity: 1 !important; visibility: visible !important; margin-bottom: 24px !important; left: auto !important; top: auto !important; padding: 24px !important; margin-left: 0 !important; margin-right: 0 !important; }\n#fs-toggle-btn { position: fixed !important; bottom: 30px !important; right: 30px !important; z-index: 999999 !important; background: #1976d2 !important; color: #fff !important; border: none !important; border-radius: 24px !important; padding: 12px 24px !important; cursor: pointer !important; font-size: 16px !important; box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important; display: flex !important; align-items: center !important; gap: 8px !important; }`
              // Toggle .standalone-exit on .v-application; default (no class) = locked fullscreen
              injectCode.body = `${injectCode.body}\n<button id="fs-toggle-btn" onclick="var el=document.querySelector('.v-application');if(!el)return;var on=!el.classList.contains('standalone-exit');if(on){el.classList.add('standalone-exit');}else{el.classList.remove('standalone-exit');}if(typeof Reveal!=='undefined'&&Reveal.layout){setTimeout(function(){Reveal.layout()},60);}this.innerHTML=on?('&#9654; Play'):('&times; Exit');" title="Toggle View" style="display:flex">&times; Exit</button>\n<script>\n(function(){\n  var BG='#191919',FG='#fff',timer;\n  function paint(){\n    var el;\n    el=document.querySelector('.reveal-viewport');if(el){el.style.setProperty('background-color',BG,'important');}\n    el=document.querySelector('.reveal');if(el){el.style.setProperty('background-color',BG,'important');}\n    document.querySelectorAll('.reveal .slides section, .slide').forEach(function(s){\n      s.style.setProperty('background-color',BG,'important');\n      s.style.setProperty('color',FG,'important');\n    });\n  }\n  paint();\n  timer=setInterval(paint,300);\n  setTimeout(function(){clearInterval(timer)},5000);\n})();\n</script>`
            }
          } else {
            // Docs domain: fullscreen toggle button
            // Docs domain: fullscreen toggle button; background/color handled by JS
            injectCode.css = `${injectCode.css}\n#fs-toggle-btn { position: fixed !important; bottom: 30px !important; right: 30px !important; z-index: 999999 !important; background: #1976d2 !important; color: #fff !important; border: none !important; border-radius: 24px !important; padding: 12px 24px !important; cursor: pointer !important; font-size: 16px !important; box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important; display: flex !important; align-items: center !important; gap: 8px !important; }\n.standalone-fullscreen { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 99999 !important; overflow: hidden !important; }\n.standalone-fullscreen .v-toolbar, .standalone-fullscreen header, .standalone-fullscreen nav-header, .standalone-fullscreen .v-navigation-drawer, .standalone-fullscreen .page-header-section, .standalone-fullscreen .v-divider, .standalone-fullscreen .page-edit-fab, .standalone-fullscreen .page-edit-shortcuts, .standalone-fullscreen .nav-footer, .standalone-fullscreen .page-toc-card, .standalone-fullscreen .page-tags-card, .standalone-fullscreen .page-comments-card, .standalone-fullscreen .page-author-card, .standalone-fullscreen .page-shortcuts-card, .standalone-fullscreen .page-col-sd, .standalone-fullscreen .comments-container, .standalone-fullscreen #discussion, .standalone-fullscreen .v-footer { display: none !important; }\n.standalone-fullscreen .reveal-viewport, .standalone-fullscreen .reveal { position: fixed !important; top: 0 !important; left: 0 !important; height: 100vh !important; width: 100vw !important; overflow: hidden !important; }\n.standalone-fullscreen .container, .standalone-fullscreen .container--fluid { width: 100% !important; max-width: 100% !important; padding: 0 !important; margin: 0 !important; }`
            injectCode.body = `${injectCode.body}\n<button id="fs-toggle-btn" onclick="var el=document.querySelector(\x27.v-application\x27);if(!el)return;var on=!el.classList.contains(\x27standalone-fullscreen\x27);if(on){el.classList.add(\x27standalone-fullscreen\x27);}else{el.classList.remove(\x27standalone-fullscreen\x27);}if(typeof Reveal!==\x27undefined\x27&&Reveal.layout){setTimeout(function(){Reveal.layout()},50);}this.innerHTML=on?\x27&times; Exit\x27:\x27&#9654; Play\x27;" title="Toggle Fullscreen" style="display:flex">&#9654; Play</button>\n<script>\n(function(){\n  var BG='#191919',FG='#fff',timer;\n  function paint(){\n    var el;\n    el=document.querySelector('.reveal-viewport');if(el){el.style.setProperty('background-color',BG,'important');}\n    el=document.querySelector('.reveal');if(el){el.style.setProperty('background-color',BG,'important');}\n    document.querySelectorAll('.reveal .slides section, .slide').forEach(function(s){\n      s.style.setProperty('background-color',BG,'important');\n      s.style.setProperty('color',FG,'important');\n    });\n  }\n  paint();\n  timer=setInterval(paint,300);\n  setTimeout(function(){clearInterval(timer)},5000);\n})();\n</script>`
          }
        }
        if (req.query.legacy || (req.get('user-agent') && req.get('user-agent').indexOf('Trident') >= 0)) {
          // -> Convert page TOC
          if (_.isString(page.toc)) {
            page.toc = JSON.parse(page.toc)
          }

          // -> Render legacy view
          res.render('legacy/page', {
            page,
            sidebar,
            injectCode,
            isAuthenticated: req.user && req.user.id !== 2
          })
        } else {
          // -> Convert page TOC
          if (!_.isString(page.toc)) {
            page.toc = JSON.stringify(page.toc)
          }

          // -> Inject comments variables
          const commentTmpl = {
            codeTemplate: WIKI.data.commentProvider.codeTemplate,
            head: WIKI.data.commentProvider.head,
            body: WIKI.data.commentProvider.body,
            main: WIKI.data.commentProvider.main
          }
          if (WIKI.config.features.featurePageComments && WIKI.data.commentProvider.codeTemplate) {
            [
              { key: 'pageUrl', value: `${WIKI.config.host}/i/${page.id}` },
              { key: 'pageId', value: page.id }
            ].forEach((cfg) => {
              commentTmpl.head = _.replace(commentTmpl.head, new RegExp(`{{${cfg.key}}}`, 'g'), cfg.value)
              commentTmpl.body = _.replace(commentTmpl.body, new RegExp(`{{${cfg.key}}}`, 'g'), cfg.value)
              commentTmpl.main = _.replace(commentTmpl.main, new RegExp(`{{${cfg.key}}}`, 'g'), cfg.value)
            })
          }

          // -> Page Filename (for edit on external repo button)
          let pageFilename = WIKI.config.lang.namespacing ? `${pageArgs.locale}/${page.path}` : page.path
          pageFilename += page.contentType === 'markdown' ? '.md' : '.html'

          // -> Render view
          res.render('page', {
            page,
            sidebar,
            injectCode,
            comments: commentTmpl,
            effectivePermissions,
            pageFilename
          })
        }
      } else if (pageArgs.path === 'home') {
        _.set(res.locals, 'pageMeta.title', 'Welcome')
        res.render('welcome', { locale: pageArgs.locale })
      } else {
        _.set(res.locals, 'pageMeta.title', 'Page Not Found')
        if (effectivePermissions.pages.write) {
          res.status(404).render('new', { path: pageArgs.path, locale: pageArgs.locale })
        } else {
          res.status(404).render('notfound', { action: 'view' })
        }
      }
    } catch (err) {
      next(err)
    }
  } else {
    if (!WIKI.auth.checkAccess(req.user, ['read:assets'], pageArgs)) {
      return res.sendStatus(403)
    }

    await WIKI.models.assets.getAsset(pageArgs.path, res)
  }
})

module.exports = router
