const { spawn } = require('child_process')
const LRU = require('lru-cache')
const express = require('express')
const swaggerUi = require('swagger-ui-express')
const swaggerJsdoc = require('swagger-jsdoc')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const got = require('got')
const { CookieJar } = require('tough-cookie')
const { JSDOM } = require('jsdom')
const Promise = require('bluebird')
const querystring = require('querystring')

;(async () => {
  const cacheExpiryMs = 24 * 60 * 60 * 1000

  const cache = new LRU({
    maxAge: cacheExpiryMs,
    max: 100
  })

  const searchCache = new LRU({
    maxAge: cacheExpiryMs,
    max: 100
  })

  async function solveCaptcha (captchas) {
    if (!Array.isArray(captchas) || !captchas.length) {
      throw new Error('captchas must be a non-empty array of buffers')
    }

    const captchaSolutions = (await Promise.all(captchas.reduce((out, buffer) => {
      const tesseractResults = [6, 7, 8].map(psm => new Promise((resolve) => {
        const t = spawn('tesseract', ['stdin', 'stdout', '--psm', `${psm}`, '--dpi', '70', '-l', 'digits'])
        t.stdin.write(buffer)
        t.stdin.end()
        t.stdout.on('data', (d) => resolve(d.toString().replace(/\n\f|\n|\f/g, '')))
	t.stderr.on('data', (d) => reject(console.error(d.toString())))
      }))
      return out.concat(tesseractResults)
    }, [])))
      .filter(result => result.length === 4)

    if (!captchaSolutions.length) {
      return ''
    }

    const [[captcha]] = Object.entries(captchaSolutions.reduce((out, solution) => {
      if (!out[solution]) {
        out[`${solution}`] = 1
      } else {
        out[`${solution}`] += 1
      }
      return out
    }, {})).sort((a, b) => b[1] - a[1])

    return captcha
  }

  function parseTenant (jsDomDocument) {
    const { document } = jsDomDocument.window

    if (document.querySelector('#errorContent')) {
      throw ({ code: 2, message: 'sole prop does not exist' })
    }

    const rules = {
      'obrt - sjedište': {
        title: 'obrt',
        appendValues: [{
          key: 'pretezita_djelatnost',
          getValue: () => {
            const { textContent } = Array.from(document.querySelectorAll('.detalj td:not(.label)')).find(x => x.textContent.includes('pretežita'))
            return textContent.substr(0, textContent.indexOf(' - ')).trim()
          }
        }, {
          key: 'url_izvatka',
          getValue: () => `https://pretrazivac-obrta.gov.hr/${document.querySelector('a[href^="izvadak.htm"]').href}`
        }]
      },
      'djelatnosti sjedišta': {
        title: 'djelatnosti',
        type: 'array',
        elements: 4,
        mapValues: {
          djelatnost (value) {
            return value.substr(0, value.indexOf(' - '))
          }
        }
      },
      'vlasnik': {
        title: 'vlasnik'
      }
    }

    const formatKey = (key) => {
      return key
        .toLowerCase()
        .trim()
        .replace(/\/|-|:|\./g, '')
        .replace(/\s+/g, '_')
        .replace(/č|ć/g, 'c')
        .replace(/š/g, 's')
        .replace(/đ/g, 'dj')
        .replace(/ž/g, 'z')
    }

    const grouped = Array.from(document.querySelectorAll('.detaljiParagraphTitle'))
      .reduce((out, titleEl) => {
        const title = titleEl.textContent.toLowerCase().trim()

        if (!rules[title]) {
          return out
        }

        out[rules[title].title] = Array.from(titleEl.parentNode.querySelectorAll('tr'))
          .filter(tr => tr.children.length % 2 === 0)
          .reduce((out, tr) => out.concat(Array.from(tr.children)), [])
          .reduce((out, td, i) => {
            if (i % 2) {
              out[out.length - 1].value = td.textContent.trim()
              return out
            }

            return out.concat({ name: td.textContent })
          }, [])
          .filter(x => x.name && x.value)
          .reduce((out, { name, value }, i) => {
            const key = formatKey(name)

            if (rules[title].type === 'array') {
              if (i === 0) {
                out = []
              }

              if (i % rules[title].elements === 0) {
                out.push({})
              }

              out[out.length - 1][key] = value === '-'
                ? ''
                : rules[title].mapValues[key]
                  ? rules[title].mapValues[key](value)
                  : value

              return out
            }

            out[key] = value === '-' ? '' : value
            return out
          }, {})

        ;(rules[title].appendValues || []).forEach(({ key, getValue }) => {
          out[rules[title].title][key] = getValue()
        })

        return out
      }, {})

    return { ...grouped.obrt, vlasnik: grouped.vlasnik, djelatnosti: grouped.djelatnosti }
  }

  async function getListing (searchParams = {}, displayParams = {}) {
    const { name, id, vatId, portorId } = searchParams
    const { page = 1 } = displayParams

    let instance = got.extend({
      baseUrl: 'https://pretrazivac-obrta.gov.hr'
    })

    const captchaAndCookieResponse = await instance.get('captcha/image.png', { encoding: null })

    const cookieJar = new CookieJar()
    captchaAndCookieResponse.headers['set-cookie'].forEach(c => {
      cookieJar.setCookieSync(c, 'https://pretrazivac-obrta.gov.hr/captcha/image.png')
    })

    instance = instance.extend({ cookieJar, form: true })

    let captchaText = await solveCaptcha([captchaAndCookieResponse.body])
    if (!captchaText) {
      const captchaResponses = await Promise.mapSeries([
        instance.get('captcha/image.png', { encoding: null }),
        instance.get('captcha/image.png', { encoding: null }),
        instance.get('captcha/image.png', { encoding: null }),
        instance.get('captcha/image.png', { encoding: null }),
        instance.get('captcha/image.png', { encoding: null })
      ], r => r.body)

      captchaText = await solveCaptcha(captchaResponses)
    }

    await instance.post('/pretraga.htm', {
      body: {
        'napredna': '1',
        'obrtNaziv': name,
        'obrtObavljanje': '',
        'obrtVrsta': '',
        'obrtMbo': id,
        'obrtBrojObrtnice': '',
        'obrtTduId': '',
        'obrtBrRegUloska': '',
        'obrtStanjeURadu': 'true',
        '_obrtStanjeURadu': 'on',
        'obrtStanjePrivObust': 'true',
        '_obrtStanjePrivObust': 'on',
        'obrtStanjeMirovanje': 'true',
        '_obrtStanjeMirovanje': 'on',
        'obrtStanjeBezPocetka': 'true',
        '_obrtStanjeBezPocetka': 'on',
        'obrtStanjeOdjava': 'true',
        '_obrtStanjeOdjava': 'on',
        'obrtStanjePreseljen': 'true',
        '_obrtStanjePreseljen': 'on',
        'obrtUlica': '',
        'obrtKucniBroj': '',
        'obrtNaseljeId': '',
        'obrtOpcinaIliGradId': '',
        'obrtZupanijaId': '',
        'obrtEmail': '',
        'obrtWwwAdresa': '',
        'vlasnikImePrezime': '',
        'vlasnikOib': vatId,
        '_pretraziVlasnikaUPasivi': 'on',
        'vlasnikUlica': '',
        'vlasnikKucniBroj': '',
        'vlasnikNaseljeId': '',
        'vlasnikOpcinaIliGradId': '',
        'vlasnikZupanijaId': '',
        'pogonNaziv': '',
        'pogonStanjeURadu': 'true',
        '_pogonStanjeURadu': 'on',
        'pogonStanjePrivObust': 'true',
        '_pogonStanjePrivObust': 'on',
        'pogonStanjeBezPocetka': 'true',
        '_pogonStanjeBezPocetka': 'on',
        'pogonObavljanje': '',
        'pogonUlica': '',
        'pogonKucniBroj': '',
        'pogonNaseljeId': '',
        'pogonOpcinaIliGradId': '',
        'pogonZupanijaId': '',
        'pogonEmail': '',
        'pogonWwwAdresa': '',
        '_djelatnostIdLista': '1',
        '_pretezitaDjelatnost': 'on',
        'kontrolniBroj': captchaText,
        'trazi': 'Traži'
      }
    })

    if (portorId) {
      return { data: [{ portorId }], totalResults: 1, instance }
    }

    const executeSearchResult = await instance.post('/pretraga.htm?izvrsiDohvat', {
      json: true,
      body: {
        'sEcho': '1',
        'iColumns': '6',
        'sColumns': '',
        'iDisplayStart': ((page - 1) * 100).toString(),
        'iDisplayLength': '100',
        'mDataProp_0': '0',
        'mDataProp_1': '1',
        'mDataProp_2': '2',
        'mDataProp_3': '3',
        'mDataProp_4': '4',
        'mDataProp_5': '5',
        'iSortingCols': '1',
        'iSortCol_0': '0',
        'sSortDir_0': 'asc',
        'bSortable_0': 'true',
        'bSortable_1': 'true',
        'bSortable_2': 'false',
        'bSortable_3': 'false',
        'bSortable_4': 'false',
        'bSortable_5': 'false',
        'iRecordsTotal': '0',
        'sortKolona': 'nazivPogona',
        'sortSmjer': 'asc'
      }
    })

    if (!executeSearchResult.body) {
      throw ({ code: 1, message: 'no response' })
    }

    const { aaData, iTotalDisplayRecords } = executeSearchResult.body

    const soleProprietorships = aaData.map(([portorId, excerptId, _, id, name, status]) => ({
      portorId,
      excerptId,
      id,
      name,
      status
    }))

    return { data: soleProprietorships, totalResults: ((page - 1) * 100) + iTotalDisplayRecords, instance }
  }

  async function getObrtV1 (req, res) {
    const { vatId = '', id = '', portorId = '' } = req.query

    if (!vatId && !id && !portorId) {
      return res.status(400).send({
        errors: [{
          source: {
            parameter: 'vatId'
          },
          code: 'invalidParameter',
          title: 'Invalid parameter',
          detail: 'Must be present if id not given'
        }, {
          source: {
            parameter: 'id'
          },
          code: 'invalidParameter',
          title: 'Invalid parameter',
          detail: 'Must be present if vatId not given'
        }]
      })
    }

    if (vatId.length && !vatId.match(/^\d{11}$/)) {
      return res.status(400).send({
        errors: [{
          source: {
            parameter: 'vatId'
          },
          code: 'invalidParameter',
          title: 'Invalid parameter',
          detail: 'Must be 11 digits'
        }]
      })
    }

    if (id.length && !id.match(/^\d{8}$/)) {
      return res.status(400).send({
        errors: [{
          source: {
            parameter: 'id'
          },
          code: 'invalidParameter',
          title: 'Invalid parameter',
          detail: 'Must be 8 digits'
        }]
      })
    }

    const cacheKey = querystring.stringify({ portorId, id, vatId })
    const cached = process.env.NODE_ENV !== 'development' && cache.get(cacheKey)
    if (cached) {
      return res.status(200).send({ data: cached })
    }

    try {
      const listing = await getListing({ id, vatId, portorId }, {})

      if (!listing.data.length) {
        return res.status(404).send({})
      }

      const [soleProp] = listing.data

      const tenantResult = await listing.instance.get(`/detalji.htm?id=${soleProp.portorId}`, {
        followRedirect: false
      })

      if (tenantResult.statusCode === 303) {
        throw ({ code: 1, message: 'no response' })
      }

      const jsDomDocument = new JSDOM(tenantResult.body)
      const tenant = parseTenant(jsDomDocument)

      cache.set(cacheKey, tenant)
      res.set('Cache-Control', `public, immutable, max-age=${cacheExpiryMs / 1000}`)
      return res.json({ data: tenant })
    } catch (err) {
      if (err.code === 1) {
        return res.status(503).send({})
      }

      if (err.code === 2) {
        return res.status(404).send({})
      }

      console.error(err)
      return res.status(500).send({})
    }
  }

  async function searchV1 (req, res) {
    const { name = '', id = '', page = 1 } = req.query

    let { query = '' } = req.query

    if (!query) {
      query = name || id
    }

    const cacheKey = querystring.stringify({ query, page })
    const cached = process.env.NODE_ENV !== 'development' && searchCache.get(cacheKey)
    if (cached) {
      return res.status(200).send(cached)
    }

    try {
      const getListingParams = {}
      if (query.match(/^\d{8}$/)) {
        getListingParams['id'] = query
      } else if (query.match(/^\d{11}$/)) {
        getListingParams['vatId'] = query
      } else {
        getListingParams['name'] = query
      }

      const listing = await getListing(getListingParams, { page })

      const response = {
        data: listing.data,
        totalResults: listing.totalResults,
        pageSize: 100
      }

      searchCache.set(cacheKey, response)
      res.set('Cache-Control', `public, immutable, max-age=${cacheExpiryMs / 1000}`)
      return res.status(200).send(response)
    } catch (err) {
      if (err.code === 1) {
        return res.status(503).send({})
      }

      return res.status(500).send({})
    }
  }

  const app = express()
  app.disable('etag')
  app.disable('x-powered-by')
  app.enable('trust proxy')

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: {
      errors: [{
        title: 'Rate limit exceeded',
        code: 'rateLimitExceeded'
      }]
    },
    skip (req) {
      const { vatId = '', id = '' } = req.query
      return cache.has(id || vatId)
    }
  })

  /**
   * @swagger
   * /:
   *   get:
   *     summary: Gets details about a sole proprietorship from its ID or its owner's VAT ID.
   *     parameters:
   *       - in: query
   *         name: portorId
   *         type: string
   *         required: false
   *         description: Required unless either `vatId` or `id` are passed. Takes precedence over both `vatId` and `id`. You can get this value from the /search endpoint.
   *       - in: query
   *         name: id
   *         type: string
   *         required: false
   *         description: ID (MBO) of the sole proprietorship. Required unless `vatID` or `portorId` are passed, ignored otherwise.
   *       - in: query
   *         name: vatId
   *         type: string
   *         required: false
   *         description: VAT ID (OIB) of the sole proprietorship's owner. Required unless `id` or `portorId` are passed, ignored otherwise.
   *     responses:
   *       200:
   *         description: Sole proprietorship details were fetched successfully.
   *       400:
   *         description: Invalid parameter(s) received. Check the response for error messages.
   *       404:
   *         description: A sole proprietorship for the given `id` or `vatId` does not exist.
   *       429:
   *         description: Rate limit exceeded.
   *       503:
   *         description: Error fetching sole proprietorship details, retry the request later.
   */
  app.get('/v1/', cors(), limiter, getObrtV1)
  /**
   * @swagger
   * /search:
   *   get:
   *     summary: Search for sole proprietorships.
   *     parameters:
   *       - in: query
   *         name: name
   *         type: string
   *       - in: query
   *         name: page
   *         type: integer
   *         required: false
   *     responses:
   *       200:
   *         description: Search results fetched successfully.
   *       400:
   *         description: Invalid parameter(s) received. Check the response for error messages.
   *       429:
   *         description: Rate limit exceeded.
   *       503:
   *         description: Error fetching search results, retry the request later.
   */
  app.get('/v1/search', cors(), limiter, searchV1)
  app.get('/', (_, res) => res.redirect(302, '/docs/v1/'))
  app.get('/docs/', (_, res) => res.redirect(302, '/docs/v1/'))

  const specs = swaggerJsdoc({
    swaggerDefinition: {
      info: {
        title: 'Portor API',
        description: 'A developer-friendly API for the Croatian sole proprietorship registry (Obrtni registar).',
        version: '1.0.0'
      },
      basePath: '/v1'
    },
    apis: ['index.js']
  })

  app.use('/docs/v1/', swaggerUi.serve, swaggerUi.setup(specs, { customSiteTitle: 'Portor API' }))

  const server = app.listen(process.env.PORT || 3000, () => {
    const { address, port } = server.address()
    console.log(`started on ${address}:${port}`)
  })
})()
