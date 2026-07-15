'use strict'
const { definePlugin } = require('trek-plugin-sdk')

function safeJson(status, obj) {
  try { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) } }
  catch (e) { return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e) }) } }
}

async function tryAttempt(fn) {
  try { return await fn() } catch (e) { return { error: e?.message || String(e) } }
}

// Shared headers that mimic a real browser request
const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'x-onetwogo-nuxt': 'true',
  'referer': 'https://traveling.com/en',
}

async function fetchJson(url, _ctx) {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

// ── Trafiklab / ResRobot (supplemental Swedish domestic transit) ───────────
// Traveling.com's own train coverage inside Sweden is sometimes thin; ResRobot
// covers all Swedish public transport (train/bus/metro/tram/ferry) and is used
// here strictly as a same-country fallback/supplement, not a replacement.

// "PT2H15M" / "PT45M" -> minutes
function parseIsoDuration(iso) {
  if (!iso) return null
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso)
  if (!m) return null
  return Number(m[1] || 0) * 60 + Number(m[2] || 0)
}

function resRobotDateTimeToStr(date, time) {
  if (!date) return null
  const t = time || '00:00:00'
  return `${date} ${t.length === 5 ? t + ':00' : t}`
}

// catOut/product naming is a HAFAS convention that varies a bit by region —
// this is a best-effort keyword mapping onto this plugin's existing mode
// vocabulary (Flight/Bus/Train/Transfer/Ferry), not an exhaustive enum.
function mapResRobotMode(product) {
  const name = ((product?.catOutL || product?.name || product?.catOut || '') + '').toLowerCase()
  if (/tåg|train|pendel|regional|snabb|express/.test(name)) return 'Train'
  if (/tunnelbana|metro|subway|spårvagn|tram/.test(name)) return 'Transfer'
  if (/färja|ferry|båt|boat/.test(name)) return 'Ferry'
  if (/flyg|air|flight/.test(name)) return 'Flight'
  return 'Bus'
}

// Traveling.com's own place data is transliterated to ASCII ("Malmo",
// "Goteborg"), but ResRobot's stop database is spelled natively ("Malmö",
// "Göteborg") — an unrestored name can miss even with fuzzy matching. Small
// fixup table for the common cases; extend as more come up.
const NORDIC_DIACRITIC_FIX = {
  malmo: 'Malmö', goteborg: 'Göteborg', gothenburg: 'Göteborg', orebro: 'Örebro',
  umea: 'Umeå', vasteras: 'Västerås', jonkoping: 'Jönköping', linkoping: 'Linköping',
  norrkoping: 'Norrköping', ornskoldsvik: 'Örnsköldsvik', skovde: 'Skövde',
  vaxjo: 'Växjö', ostersund: 'Östersund', gavle: 'Gävle', boras: 'Borås',
  molndal: 'Mölndal', harnosand: 'Härnösand', sodertalje: 'Södertälje',
  hassleholm: 'Hässleholm', angelholm: 'Ängelholm',
}

// These HAFAS-derived JSON APIs commonly collapse a single-element array to a
// bare object (a leftover of their XML origins) — normalize either shape.
function toArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x] }

async function resRobotLocationNameRaw(input, apiKey, ctx, label) {
  const url = `https://api.resrobot.se/v2.1/location.name?input=${encodeURIComponent(input)}&format=json&accessId=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ResRobot location.name HTTP ${res.status}`)
  const data = await res.json()
  // Real (observed live) shape: { stopLocationOrCoordLocation: [{ StopLocation: {...} }, ...] }
  // at the ROOT — no "LocationList" wrapper, despite some docs implying one.
  // Kept both root and LocationList-nested paths since HAFAS deployments vary.
  const nested = toArray(data?.stopLocationOrCoordLocation ?? data?.LocationList?.stopLocationOrCoordLocation)
    .map(x => x?.StopLocation || x).filter(Boolean)
  const flat = toArray(data?.StopLocation ?? data?.LocationList?.StopLocation)
  const stops = flat.length ? flat : nested
  ctx?.log?.info?.(`ResRobot location.name(${label}="${input}"): ${stops.length} hit(s), raw keys: ${Object.keys(data || {}).join(',')}`)
  return stops[0] || null
}

async function resRobotLocationSearch(name, apiKey, ctx) {
  // Trailing "?" turns on fuzzy/substring matching. Try that, then an exact
  // match, then — if this is a name known to lose a diacritic in transit —
  // the same two attempts with the diacritic restored.
  const fixed = NORDIC_DIACRITIC_FIX[name.trim().toLowerCase()]
  const attempts = fixed ? [name + '?', name, fixed + '?', fixed] : [name + '?', name]
  for (const input of attempts) {
    const hit = await resRobotLocationNameRaw(input, apiKey, ctx, name)
    if (hit) return hit
  }
  return null
}

async function resRobotTrip(originId, destId, date, time, apiKey) {
  const url = `https://api.resrobot.se/v2.1/trip?format=json&originId=${encodeURIComponent(originId)}&destId=${encodeURIComponent(destId)}` +
    `&date=${encodeURIComponent(date)}${time ? `&time=${encodeURIComponent(time)}` : ''}&accessId=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ResRobot trip HTTP ${res.status}`)
  const data = await res.json()
  return toArray(data?.TripList?.Trip || data?.Trip)
}

function resRobotPlace(o) {
  if (!o) return null
  return { id: null, name: o.name, nameFull: o.name, code: null, countryCode: 'SE', lat: o.lat, lng: o.lon }
}

function normalizeResRobotTrip(trip, i) {
  const legs = toArray(trip?.LegList?.Leg)
  const realLegs = legs.filter(l => toArray(l?.Product).length)
  const origin = trip?.Origin || {}
  const destination = trip?.Destination || {}

  const segments = realLegs.map(leg => {
    const product = toArray(leg.Product)[0] || {}
    return {
      depTime: resRobotDateTimeToStr(leg.Origin?.date, leg.Origin?.time),
      arrTime: resRobotDateTimeToStr(leg.Destination?.date, leg.Destination?.time),
      durationMin: parseIsoDuration(leg.duration),
      from: resRobotPlace(leg.Origin),
      to: resRobotPlace(leg.Destination),
      operator: product.operator || null,
      flightNo: product.line || null,
      class: null,
    }
  })

  // The gap between consecutive real legs (covers WALK/TRSF transfer legs
  // without needing to parse each one individually).
  const layovers = []
  for (let s = 1; s < segments.length; s++) {
    layovers.push({ durationMin: null, description: `Change at ${realLegs[s]?.Origin?.name || ''}` })
  }

  const operators = []
  segments.forEach(s => { if (s.operator && !operators.find(o => o.name === s.operator)) operators.push({ id: null, name: s.operator, logo: null, rating: null }) })

  return {
    id: 'tl-' + i,
    tripKey: null,
    isBookable: false,
    vehclass: 'transit',
    mode: mapResRobotMode(toArray(realLegs[0]?.Product)[0]),
    depTime: resRobotDateTimeToStr(origin.date, origin.time),
    arrTime: resRobotDateTimeToStr(destination.date, destination.time),
    durationMin: parseIsoDuration(trip?.duration),
    from: resRobotPlace(origin),
    to: resRobotPlace(destination),
    operators,
    price: { value: null, currency: null, display: null },
    class: null,
    seats: null,
    isRefundable: false,
    features: [{ key: 'source_trafiklab', text: 'Data from Trafiklab.se', type: 'default', variant: 'info' }],
    segments,
    layovers,
    isMultiSegment: segments.length > 1,
    addToCartParams: null,
    logoPath: null,
    source: 'trafiklab',
  }
}

module.exports = definePlugin({
  async onLoad(ctx) { ctx.log.info('transport-search loaded') },

  routes: [

    // ── Place autocomplete ────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/places',
      auth: true,
      async handler(req, ctx) {
        const q = req.query.q || ''
        if (q.length < 2) return safeJson(200, { places: [] })
        try {
          const url = `https://traveling.com/api/nuxt/en/typeahead/fetch?query=${encodeURIComponent(q)}`
          const data = await fetchJson(url, ctx)
          // Response is a flat array of place objects
          const arr = Array.isArray(data) ? data : []
          const places = arr.slice(0, 12).map(p => ({
            id: p.id,                          // e.g. "978p" or "123208s"
            name: p.name_en || p.name,
            nameFull: p.name_en || p.name,
            slug: p.slug,
            countryCode: p.c,
            countrySlug: p.countrySlug,
            country: p.country,
            type: p.v || null,                 // bus | train | avia | charter | ""
            code: p.code || null,
          }))
          return safeJson(200, { places })
        } catch (e) {
          return safeJson(200, { places: [], error: e.message })
        }
      },
    },

    // ── Main search ───────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/search',
      auth: true,
      async handler(req, ctx) {
        const { fromId, toId, fromSlug, toSlug, fromCountrySlug, toCountrySlug, date, people, adults } = req.query
        if (!fromId || !toId || !date) return safeJson(200, { error: 'fromId, toId, date required' })

        const p = people || '1'
        const a = adults || p
        const csrf = 'plugin1'

        const searchUrl = `https://traveling.com/api/nuxt/en/tripsV2/search` +
          `?fromId=${fromId}&toId=${toId}` +
          `&fromSlug=${fromSlug||''}&toSlug=${toSlug||''}` +
          `&fromCountrySlug=${fromCountrySlug||''}&toCountrySlug=${toCountrySlug||''}` +
          `&people=${p}&adults=${a}&children=undefined&infants=undefined` +
          `&date=${date}&date2=undefined&csrf=${csrf}` +
          `&direction=forward&cartHash=&outboundTripKey=&outboundGodate=`

        try {
          const data = await fetchJson(searchUrl, ctx)
          const trips = data.trips || []
          const recheck = data.recheck || []
          const token = data.token || null

          return safeJson(200, {
            trips: trips.map(normalizeTrip),
            recheck: recheck.length > 0,
            recheckUrls: recheck,
            token,
            fromId, toId, date,
          })
        } catch (e) {
          return safeJson(200, { trips: [], error: e.message })
        }
      },
    },

    // ── Supplemental Swedish transit search (Trafiklab / ResRobot) ─────────────
    {
      method: 'GET',
      path: '/transit-search',
      auth: true,
      async handler(req, ctx) {
        const { fromName, toName, fromCountry, toCountry, date, time } = req.query
        if (!fromName || !toName || !date) return safeJson(200, { trips: [] })

        const apiKey = await ctx.settings.get('trafiklab_api_key')
        if (!apiKey) return safeJson(200, { trips: [], error: 'not_configured' })

        // ResRobot only covers Sweden's own network — a domestic-only fallback,
        // not a cross-border one.
        if ((fromCountry || '').toUpperCase() !== 'SE' || (toCountry || '').toUpperCase() !== 'SE') {
          return safeJson(200, { trips: [] })
        }

        try {
          const [origin, dest] = await Promise.all([
            resRobotLocationSearch(fromName, apiKey, ctx),
            resRobotLocationSearch(toName, apiKey, ctx),
          ])
          if (!origin || !dest) {
            return safeJson(200, { trips: [], error: `stop lookup failed (${!origin ? `origin "${fromName}"` : `destination "${toName}"`} had no match)` })
          }

          const trips = await resRobotTrip(origin.extId || origin.id, dest.extId || dest.id, date, time, apiKey)
          return safeJson(200, { trips: trips.map(normalizeResRobotTrip), source: 'trafiklab' })
        } catch (e) {
          return safeJson(200, { trips: [], error: e.message })
        }
      },
    },

    // ── Save to Transports tab ─────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/save-transport',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.body?.tripId)
        const trip = req.body?.trip
        if (!tripId || !trip) return safeJson(200, { error: 'tripId and trip required' })
        const result = await tryAttempt(async () => {
          const typeMap = { Flight: 'flight', Bus: 'bus', Train: 'train', Transfer: 'car', Ferry: 'ferry' }
          const type = typeMap[trip.mode] || 'transport_other'
          const opName = (trip.operators || [])[0]?.name || trip.mode
          const title = opName + ' ' + (trip.from?.name || '') + ' → ' + (trip.to?.name || '')

          // "YYYY-MM-DD HH:mm:ss" -> { date: 'YYYY-MM-DD', time: 'HH:mm' }
          function splitDateTime(s) {
            if (!s) return { date: null, time: null }
            const [date, time] = String(s).split(' ')
            return { date: date || null, time: time ? time.slice(0, 5) : null }
          }
          // Nearest day in the trip matching a date, so the booking lands on the
          // right day even if the trip's day range doesn't exactly cover it.
          function resolveDayId(days, date) {
            if (!date || !days.length) return null
            const exact = days.find(d => d.date === date)
            if (exact) return exact.id
            const target = new Date(date).getTime()
            let best = null, bestDiff = Infinity
            for (const d of days) {
              if (!d.date) continue
              const diff = Math.abs(new Date(d.date).getTime() - target)
              if (diff < bestDiff) { bestDiff = diff; best = d.id }
            }
            return best
          }
          function formatDuration(min) {
            if (min == null) return null
            const h = Math.floor(min / 60), m = min % 60
            return h ? `${h}h ${m}m` : `${m}m`
          }
          function buildNotes(trip) {
            const lines = []
            if (trip.class) lines.push(`Class: ${trip.class}`)
            if (trip.seats != null) lines.push(`Seats available: ${trip.seats}`)
            lines.push(`Refundable: ${trip.isRefundable ? 'Yes' : 'No'}`)
            const dur = formatDuration(trip.durationMin)
            if (dur) lines.push(`Duration: ${dur}`)
            if (trip.price?.display) lines.push(`Price: ${trip.price.display}`)
            const ratedOps = (trip.operators || []).filter(o => o.rating).map(o => `${o.name} (${o.rating}/5)`)
            if (ratedOps.length) lines.push(`Operator rating: ${ratedOps.join(', ')}`)
            if (trip.features?.length) lines.push(`Notes: ${trip.features.map(f => f.text).join('; ')}`)
            if (trip.isMultiSegment && trip.segments?.length) {
              lines.push('Segments:')
              trip.segments.forEach((seg, i) => {
                const legDur = formatDuration(seg.durationMin)
                lines.push(`  ${i + 1}. ${seg.from?.name || ''} → ${seg.to?.name || ''}` +
                  (seg.operator ? ` (${seg.operator}${seg.flightNo ? ' ' + seg.flightNo : ''})` : '') +
                  ` ${seg.depTime || ''} - ${seg.arrTime || ''}${legDur ? ' (' + legDur + ')' : ''}`)
              })
            }
            if (trip.layovers?.length) {
              trip.layovers.forEach(l => {
                const d = formatDuration(l.durationMin)
                lines.push(`Layover${d ? ` (${d})` : ''}: ${l.description || ''}`)
              })
            }
            return lines.join('\n')
          }

          let days = []
          try { days = (await ctx.trips.getDays(tripId)) || [] } catch (_e) { days = [] }
          const dep = splitDateTime(trip.depTime)
          const arr = splitDateTime(trip.arrTime)
          const day_id = resolveDayId(days, dep.date)
          const end_day_id = resolveDayId(days, arr.date)
          const reservation_time = (dep.date && dep.time) ? `${dep.date}T${dep.time}` : null
          const reservation_end_time = (arr.date && arr.time) ? `${arr.date}T${arr.time}` : null

          // A bare 3-letter code is only meaningful for airports — the edit form's
          // AirportSelect re-parses "City (CODE)" out of the endpoint name and needs
          // an exact IATA code to do it, so only stamp `code`/that name format for
          // flights (bus/train stops keep their plain name, matching the app itself).
          const IATA_RE = /^[A-Za-z]{3}$/
          function ep(role, sequence, place, dateTimeStr) {
            const { date, time } = splitDateTime(dateTimeStr)
            const code = (type === 'flight' && place?.code && IATA_RE.test(place.code)) ? place.code.toUpperCase() : null
            const plainName = place?.nameFull || place?.name || role
            const name = code ? `${(place?.name || plainName).replace(/\s*\([A-Za-z]{3}\)\s*$/, '')} (${code})` : plainName
            const e = { role, sequence, name, code, local_date: date, local_time: time }
            if (place?.lat != null) e.lat = place.lat
            if (place?.lng != null) e.lng = place.lng
            return e
          }
          // One waypoint per stop (N segments -> N+1 waypoints), not two per segment —
          // otherwise a layover airport is duplicated as both a 'stop' and the next
          // leg's 'from', which broke the edit form's airport/time lookup.
          const endpoints = []
          if (trip.segments && trip.segments.length > 1) {
            trip.segments.forEach((seg, i) => {
              if (i === 0) endpoints.push(ep('from', 0, seg.from, seg.depTime))
              const role = (i === trip.segments.length - 1) ? 'to' : 'stop'
              endpoints.push(ep(role, i + 1, seg.to, seg.arrTime))
            })
          } else {
            endpoints.push(ep('from', 0, trip.from, trip.depTime))
            endpoints.push(ep('to', 1, trip.to, trip.arrTime))
          }

          // The edit form reads airline/flight-or-train-number and per-leg times from
          // `metadata`, not from the endpoints or the top-level reservation fields —
          // without this a saved flight showed no airline and blank leg times.
          const metadata = {}
          if (type === 'flight' || type === 'train') {
            const segs = trip.segments?.length ? trip.segments : [{
              from: trip.from, to: trip.to, depTime: trip.depTime, arrTime: trip.arrTime, operator: opName, flightNo: null,
            }]
            const first = segs[0]
            const last = segs[segs.length - 1]
            if (type === 'flight') {
              if (first.operator) metadata.airline = first.operator
              if (first.flightNo) metadata.flight_number = first.flightNo
              if (first.from?.code) metadata.departure_airport = first.from.code.toUpperCase()
              if (last.to?.code) metadata.arrival_airport = last.to.code.toUpperCase()
            } else if (first.flightNo) {
              metadata.train_number = first.flightNo
            }
            if (segs.length > 1) {
              metadata.legs = segs.map(seg => {
                const segDep = splitDateTime(seg.depTime)
                const segArr = splitDateTime(seg.arrTime)
                const leg = {
                  from: type === 'flight' ? (seg.from?.code || seg.from?.name || '') : (seg.from?.nameFull || seg.from?.name || ''),
                  to: type === 'flight' ? (seg.to?.code || seg.to?.name || '') : (seg.to?.nameFull || seg.to?.name || ''),
                  dep_day_id: resolveDayId(days, segDep.date),
                  dep_time: segDep.time,
                  arr_day_id: resolveDayId(days, segArr.date),
                  arr_time: segArr.time,
                }
                if (type === 'flight') {
                  if (seg.operator) leg.airline = seg.operator
                  if (seg.flightNo) leg.flight_number = seg.flightNo
                } else if (seg.flightNo) {
                  leg.train_number = seg.flightNo
                }
                return leg
              })
            }
          }

          // create_budget_entry has no currency of its own — it's stored verbatim in
          // the trip's base currency. Convert the fare (often USD/JPY/etc from the
          // search API) into that currency first, so Costs doesn't show e.g. a JPY
          // amount mislabeled as EUR.
          async function toTripCurrency(amount, fromCurrency) {
            if (!amount || !fromCurrency) return { amount, currency: fromCurrency, note: null }
            let tripCurrency = null
            try {
              const trips = await ctx.trips.listMine()
              tripCurrency = (trips || []).find(t => t.id === tripId)?.currency || null
            } catch (_e) { tripCurrency = null }
            if (!tripCurrency || tripCurrency.toUpperCase() === fromCurrency.toUpperCase()) {
              return { amount, currency: tripCurrency || fromCurrency, note: null }
            }
            try {
              const rates = await ctx.rates.get(tripCurrency)
              const rate = rates?.[fromCurrency.toUpperCase()]
              if (rate > 0) {
                const converted = Math.round((amount / rate) * 100) / 100
                return { amount: converted, currency: tripCurrency, note: `Converted from ${fromCurrency} ${amount} at ~${rate.toFixed(4)} ${fromCurrency}/${tripCurrency}` }
              }
            } catch (_e) { /* fall through to unconverted */ }
            return { amount, currency: fromCurrency, note: `Could not convert ${fromCurrency} to ${tripCurrency} — recorded as ${fromCurrency} ${amount}, verify manually` }
          }

          const payload = {
            title, type, status: 'pending', endpoints,
            day_id, end_day_id,
            reservation_time, reservation_end_time,
          }
          if (Object.keys(metadata).length) payload.metadata = metadata
          // Auto-create the linked expense from the fare, in the right Costs bucket.
          if (trip.price?.value) {
            const conv = await toTripCurrency(trip.price.value, trip.price.currency)
            payload.create_budget_entry = { total_price: conv.amount, category: type === 'flight' ? 'flights' : 'transport' }
            payload.notes = conv.note ? `${buildNotes(trip)}\n${conv.note}` : buildNotes(trip)
          } else {
            payload.notes = buildNotes(trip)
          }

          ctx.log.info('endpoints: ' + JSON.stringify(endpoints))
          const reservation = await ctx.reservations.create(tripId, payload)
          return { ok: true, reservationId: reservation?.id ?? reservation?.data?.id }
        })
        return safeJson(200, result)
      },
    },

    {
      method: 'POST',
      path: '/recheck',
      auth: true,
      async handler(req, ctx) {
        const urls = req.body?.urls || []
        if (!urls.length) return safeJson(200, { trips: [] })

        const allTrips = []
        // Poll up to 3 recheck URLs concurrently
        const promises = urls.slice(0, 3).map(async (url) => {
          try {
            // recheck URLs are on recheck10.12go.com / recheck11.12go.com
            const data = await fetchJson(url, ctx)
            const trips = data.trips || data.results || []
            trips.forEach(t => allTrips.push(normalizeTrip(t)))
          } catch (_e) { /* recheck failures are non-fatal */ }
        })
        await Promise.all(promises)
        return safeJson(200, { trips: allTrips })
      },
    },

    // ── Build booking URL ─────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/book-url',
      auth: true,
      async handler(req, ctx) {
        const { tripKey, godate, godate2, fromSlug, toSlug } = req.query
        if (!tripKey) return safeJson(200, { error: 'tripKey required' })
        // Construct the booking URL for traveling.com
        const base = `https://traveling.com/en/travel/${fromSlug||''}/${toSlug||''}`
        const params = new URLSearchParams({ trip_key: tripKey, godate: godate || '' })
        if (godate2) params.set('godate2', godate2)
        return safeJson(200, { url: `${base}?${params.toString()}` })
      },
    },
  ],
})

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeTrip(t) {
  if (!t) return null
  const opt = (t.travel_options || [])[0] || {}
  const price = opt.min_price || opt.price || t.min_price || {}
  const vehclass = (t.vehclasses || [])[0] || 'unknown'
  const segments = (t.segments || []).filter(s => s.type === 'route')
  const waits = (t.segments || []).filter(s => s.type === 'wait')

  return {
    id: t.id,
    tripKey: opt.trip_key || t.trip_key,
    isBookable: t.is_bookable,
    vehclass,                          // avia | bus | train | charter | ferry
    mode: vehclassToMode(vehclass),    // Flight | Bus | Train | Transfer | Ferry
    depTime: t.dep_time,
    arrTime: t.arr_time,
    durationMin: t.duration,
    from: normPlace(t.from),
    to: normPlace(t.to),
    operators: (t.operators || []).map(o => ({
      id: o.id,
      name: o.name,
      logo: o.logo ? `https://traveling.com/images/${o.logo.path}` : null,
      rating: o.rating,
    })),
    price: {
      value: price.value,
      currency: price.fxcode || 'EUR',
      display: price.value ? `${price.fxcode || 'EUR'} ${Number(price.value).toFixed(0)}` : null,
    },
    class: opt.class?.name || null,
    seats: opt.available_seats || null,
    isRefundable: opt.is_generally_refundable || false,
    features: Object.values(opt.features || {}).map(f => ({
      key: f.key, text: f.text, type: f.type, variant: f.variant,
    })),
    segments: segments.map(s => ({
      depTime: s.dep_time,
      arrTime: s.arr_time,
      durationMin: s.duration,
      from: normPlace(s.from),
      to: normPlace(s.to),
      operator: s.operator?.name || null,
      flightNo: s.official_id || null,
      class: s.class?.name || null,
    })),
    layovers: waits.map(w => ({ durationMin: w.duration, description: w.description })),
    isMultiSegment: segments.length > 1,
    addToCartParams: opt.add_to_cart_params || null,
    logoPath: (t.operators || [])[0]?.logo?.path || null,
  }
}

function normPlace(p) {
  if (!p) return null
  return { id: p.id, name: p.name, nameFull: p.name_full || p.name, code: p.code || null, countryCode: p.country_code, lat: p.lat, lng: p.lng }
}

function vehclassToMode(v) {
  const map = { avia: 'Flight', bus: 'Bus', train: 'Train', charter: 'Transfer', ferry: 'Ferry', taxi: 'Taxi' }
  return map[v] || v
}

function normalizePass(p) {
  return {
    id: p.mainPassId,
    name: p.name,
    description: p.description,
    validity: p.validity || [],
    operators: p.operators || [],
    classes: (p.classOptions || []).map(c => ({
      id: c.id,
      name: c.name,
      minPrice: c.minPrice,
      available: c.available,
      photo: c.photos?.[0]?.[0] ? `https://traveling.com/${c.photos[0][0]}` : null,
    })),
    regions: (p.regions || []).map(r => r.name),
    available: p.available,
    slug: p.slug,
  }
}

// TEMP DEBUG — remove after checking
