/**
 * dsh-device-badge — client half.
 *
 * Renders one compact badge INSIDE the account row at the bottom of the sidebar
 * (same line as the signed-in user), showing:
 *
 *     MacBook Air M1   58%   [battery glyph]
 *
 * Order is model → percentage → icon, with no progress bar, per the requested
 * design. Polls the host route GET /api/device-badge/status (loopback only,
 * session-authenticated) and never talks to the network.
 *
 * The badge is registered into `settings.launcher.notifications` — the only
 * sidebar slot that lives inside the account row. That slot's own wrapper is
 * absolutely positioned ABOVE the row by default, so a scoped rule moves it
 * back over the row and lets pointer events fall through to the account button.
 * The rule keys off `data-slot` (a stable host attribute) rather than a hashed
 * class name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-device-badge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useRef } = React

    const ENDPOINT = '/api/device-badge/status'
    const POLL_MS = 20_000
    const SLOT = 'settings.launcher.notifications'

    const TEXT = {
      zh: {
        charging: '充电中',
        charged: '已充满',
        acAttached: '已接电源',
        remaining: '剩余',
        noBattery: '未检测到电池',
        unavailable: '读取失败',
        unknown: '未知',
      },
      en: {
        charging: 'Charging',
        charged: 'Charged',
        acAttached: 'Power adapter',
        remaining: 'left',
        noBattery: 'No battery',
        unavailable: 'Unavailable',
        unknown: 'Unknown',
      },
    }

    function pickText(ctx) {
      try {
        const active = ctx?.locale?.getSnapshot?.()?.active
        if (typeof active === 'string' && active.toLowerCase().startsWith('zh')) return TEXT.zh
      } catch {
        /* fall through */
      }
      return TEXT.en
    }

    function formatRemaining(minutes) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return null
      const total = Math.round(minutes)
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * macOS menu bar colours: the glyph is monochrome and follows the theme;
     * it only turns red at a critical charge, matching the system behaviour.
     */
    /**
     * Detect the active colour scheme. DSH publishes it as `color-scheme` on
     * <html>, so this also follows manual theme switches, not just the OS
     * preference.
     */
    function isLightScheme() {
      try {
        const scheme = getComputedStyle(document.documentElement).colorScheme || ''
        if (scheme.includes('light')) return true
        if (scheme.includes('dark')) return false
      } catch {
        /* fall through */
      }
      return !window.matchMedia?.('(prefers-color-scheme: dark)').matches
    }

/**
     * One colour for the model, the percentage and the battery glyph.
     *
     * The glyph draws with `currentColor`, so whatever this returns is also the
     * battery colour — keeping the three elements visually identical by
     * construction rather than by matching hex values in two places.
     */
    function toneFor(state) {
      if (state === null) return 'var(--dsw-alias-label-tertiary, #888)'
      if (
        typeof state.percent === 'number' &&
        state.percent <= 10 &&
        !state.charging &&
        !state.charged
      ) {
        return 'var(--dsw-alias-state-error-primary, #e5484d)'
      }
      return 'var(--dsw-alias-label-primary, #1d1d1f)'
    }

    /**
     * Which overlay glyph the icon should show.
     *
     * macOS shows a plug whenever the Mac is on power — both while charging and
     * when full. That is what the reference screenshots show, so charging uses
     * the plug too rather than a bolt.
     */
    function modeFor(state) {
      if (state === null || state.hasBattery === false) return null
      // macOS keeps the bolt visible whenever the Mac is on power — including
      // at 100% ("charged") — because the cable is still connected. The plug
      // only appears for the unusual "AC attached but not charging" case
      // (battery care / charge limit).
      if (state.charging || state.charged) return 'bolt'
      if (state.acAttached) return 'plug'
      return null
    }

    /** How wide a background-coloured gap surrounds the charging glyph. */
    const GLYPH_GAP = 2.6

    /**
 * Plug silhouette — a 1024-unit icon (two prongs, a rounded body, a cord).
 * It is mapped into the 26×18 battery grid at render time, so the geometry
 * lives in its native coordinate space rather than being hand-scaled.
 */
    const PLUG_PATH =
      'M400.896 0c25.856 0 46.848 21.76 46.848 48.64v161.664h112.256V48.64'
      + 'c0-26.88 20.992-48.512 46.72-48.512h28.16c25.856 0 46.848 21.76 46.848 48.64'
      + 'v161.664h96.512c17.28 0 37.76 13.696 37.76 38.4v220.416'
      + 'c0 132.864-93.568 241.152-218.624 277.76v159.104'
      + 'c0 35.712-27.904 64.64-62.464 64.64h-62.336'
      + 'a63.616 63.616 0 0 1-62.464-64.64V746.752'
      + 'C285.44 710.016 192 601.856 192 469.248V248.704'
      + 'c0-24.576 20.48-38.4 37.76-38.4h96.256V48.64'
      + 'c0-26.88 20.992-48.512 46.72-48.512h28.16z'

    /** Native bounding box of PLUG_PATH, used to scale it into the battery. */
    const PLUG_BOX = { x0: 192, x1: 814, y0: 0, y1: 968 }
    /** How tall the plug renders inside the 26×18 grid. */
    const PLUG_HEIGHT = 13

/** Charging bolt outline — overflows the shell above and below. */
    const BOLT_PATH = 'M13.55 1.0 L8.05 9.2 H11.2 L9.85 17.0 L15.55 8.1 H12.35 Z'

    /** Monotonic counter so every mounted badge gets a unique mask id. */
    let badgeSeq = 0

    /**
     * macOS menu-bar battery glyph.
     *
     * Proportions taken from the real menu-bar icon: a rounded-rectangle shell
     * (small corner radius, NOT a pill), a half-round nub on the right, and a
     * proportional inner fill with small rounded corners.
     *
     * Overlay glyphs use a background-coloured halo (`paint-order: stroke
     * fill`) so they stay legible whether they land on the filled or empty part
     * of the battery — a plain knockout disappears at low charge.
     */
    function BatteryGlyph({ percent, mode, color, width }) {
      const pct = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0

      // A duplicated mask id would make every badge clip to the first one's
      // shape, so each instance owns its own.
      const maskId = useRef(null)
      if (maskId.current === null) maskId.current = `dsh-battery-bolt-${++badgeSeq}`

      const VB_W = 26
      const VB_H = 18
      const height = (width * VB_H) / VB_W

      // Shell: 22 × 11 with a 3.2 radius — matches the system icon's softness.
      const sx = 0.85
      const sy = 3.5
      const sw = 22
      const sh = 11
      const sr = 3.0
      const stroke = 1.15

      // Fill: inset by stroke + 0.7, radius scales with the fill height.
      const inset = stroke + 0.7
      const fx = sx + inset
      const fy = sy + inset
      const fh = sh - inset * 2
      const fw = Math.max(0, (sw - inset * 2) * (pct / 100))

      // Nub: a half-round bump on the right edge.
      const nubX = sx + sw + 0.55
      const nubY = sy + sh / 2 - 1.5

      const glyph = mode === 'bolt' || mode === 'plug' ? mode : null
      const bg = 'var(--dsw-alias-bg-layer-1, #fff)'

      // Both glyphs are drawn in their own coordinate space and mapped onto
      // the 26×18 battery grid here. The plug arrives as a 1024-unit icon, so
      // it needs both a scale and a centre offset; the bolt is already local.
      const plugScale = PLUG_HEIGHT / (PLUG_BOX.y1 - PLUG_BOX.y0)
      const plugCX = (PLUG_BOX.x0 + PLUG_BOX.x1) / 2
      const plugCY = (PLUG_BOX.y0 + PLUG_BOX.y1) / 2
      // The bolt's native height is 16 units; shrink it to 12 to match the
      // plug's visual weight. Scaling happens about the shell centre (11.85,
      // 9), then the -0.4 optical lift is applied in scaled units.
      const BOLT_HEIGHT = 12
      const boltScale = BOLT_HEIGHT / 16
      const glyphTransform =
        glyph === 'plug'
          ? `translate(${(11.85 - plugCX * plugScale).toFixed(3)} ${(9.0 - plugCY * plugScale).toFixed(3)}) scale(${plugScale.toFixed(5)})`
          : glyph === 'bolt'
            ? `translate(11.85 9) scale(${boltScale}) translate(-11.85 -9) translate(0 -0.4)`
            : undefined
      // The gap is specified in battery-grid units, so the plug (drawn at
      // 1/64th scale) needs it divided back out to stay visually equal.
      const glyphGap =
        glyph === 'plug' ? GLYPH_GAP / plugScale : glyph === 'bolt' ? GLYPH_GAP / boltScale : GLYPH_GAP
      const glyphPath = glyph === 'plug' ? PLUG_PATH : BOLT_PATH

      return h(
        'svg',
        {
          width,
          height,
          viewBox: `0 0 ${VB_W} ${VB_H}`,
          'aria-hidden': true,
          focusable: false,
          // The charging bolt intentionally overflows the shell; without this
          // the SVG viewport would clip it.
          //
          // The box is an integer 26×18 (matching the viewBox 1:1), which is
          // what makes this stable across pixel densities. On top of that, a
          // half-pixel lift: the battery outline sits slightly below the digits'
          // optical centre because its shell is drawn with the bolt overhang
          // included in the viewBox. `-0.5px` measured identically at DPR 1
          // and DPR 2, unlike the old `-1px` which only fixed one of them.
          style: {
            flexShrink: 0,
            display: 'block',
            color,
            overflow: 'visible',
            transform: 'translateY(-0.5px)',
          },
        },
        // Whole battery (shell + nub + charge fill) shares one mask so the
        // charging glyph cuts through *everything* — including the shell
        // outline — not just the fill. The glyph is then painted back solid
        // on top, which is what produces the floating-bolt look.
        glyph !== null &&
          h(
            'mask',
            { id: maskId.current, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: VB_W, height: VB_H },
            h('rect', { x: 0, y: 0, width: VB_W, height: VB_H, fill: '#fff' }),
            // Outline-only pass: knocks a background-coloured ring around the
            // glyph, which is the gap you see between bolt and battery.
            h('path', {
              d: glyphPath,
              fill: 'none',
              stroke: '#000',
              strokeWidth: glyphGap,
              strokeLinejoin: 'round',
              transform: glyphTransform,
            }),
          ),
        h(
          'g',
          glyph === null ? {} : { mask: `url(#${maskId.current})` },
          // Shell
          h('rect', {
            x: sx,
            y: sy,
            width: sw,
            height: sh,
            rx: sr,
            ry: sr,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: stroke,
          }),
          // Nub
          h('path', {
            d: `M${nubX} ${nubY} A 1.5 1.5 0 0 1 ${nubX} ${nubY + 3} Z`,
            fill: 'currentColor',
          }),
          // Charge level
          pct > 0 &&
            h('rect', {
              x: fx,
              y: fy,
              width: fw,
              height: fh,
              rx: 1.8,
              ry: 1.8,
              fill: 'currentColor',
            }),
        ),
        // Glyph body, painted back solid after the masked fill has cut the
        // gap around it. Order matters: fill (masked) → body (solid).
        glyph !== null &&
          h('path', {
            d: glyphPath,
            fill: 'currentColor',
            transform: glyphTransform,
          }),
      )
    }

    /**
     * Battery state, driven by the browser's own Battery Status API.
     *
     * `navigator.getBattery()` fires `chargingchange` / `levelchange` the
     * instant the plug goes in or out — far faster than polling. Verified on
     * this Mac: its level/charging/dischargingTime match `pmset -g batt`
     * exactly, so the two sources agree.
     *
     * The host route is still fetched for the model name plus the derived
     * status text, but every Battery API event triggers an immediate `fresh`
     * fetch. A slow poll remains as a fallback for browsers without the API
     * and for wall-clock-only changes (e.g. "1:33 remaining" ticking down).
     */
    function useBatteryStatus() {
      const [state, setState] = useState(null)
      const [failed, setFailed] = useState(false)
      const alive = useRef(true)
      const batteryRef = useRef(null)

      useEffect(() => {
        alive.current = true
        let timer = null
        let lastFresh = 0

        const load = async (fresh = false) => {
          try {
            const url = `${ENDPOINT}?t=${Date.now()}${fresh ? '&fresh=1' : ''}`
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!alive.current) return
            setState(body)
            setFailed(false)
          } catch {
            if (alive.current) setFailed(true)
          }
        }

        // Debounce the fresh fetch so a burst of API events (plug in + level +
        // chargingTime often fire together) still means one request.
        const loadSoon = () => {
          const now = Date.now()
          if (now - lastFresh < 400) return
          lastFresh = now
          void load(true)
        }

        void load(true)

        // Primary path: Battery API events.
        let detach = () => {}
        if (typeof navigator.getBattery === 'function') {
          navigator
            .getBattery()
            .then((battery) => {
              if (!alive.current) return
              batteryRef.current = battery
              const onChange = () => loadSoon()
              battery.addEventListener('chargingchange', onChange)
              battery.addEventListener('levelchange', onChange)
              battery.addEventListener('chargingtimechange', onChange)
              battery.addEventListener('dischargingtimechange', onChange)
              detach = () => {
                battery.removeEventListener('chargingchange', onChange)
                battery.removeEventListener('levelchange', onChange)
                battery.removeEventListener('chargingtimechange', onChange)
                battery.removeEventListener('dischargingtimechange', onChange)
              }
            })
            .catch(() => {
              /* API present but blocked; the poll below covers it */
            })
        }

        // Fallback: low-frequency poll for the remaining-time text and for
        // browsers without the Battery API.
        timer = setInterval(() => void load(false), POLL_MS)

        const onVisible = () => {
          if (!document.hidden) void load(true)
        }
        document.addEventListener('visibilitychange', onVisible)

        return () => {
          alive.current = false
          if (timer !== null) clearInterval(timer)
          detach()
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      return { state, failed }
    }

    /** Re-render when the host switches between light and dark. */
    function useLightScheme() {
      const [light, setLight] = useState(() => isLightScheme())

      useEffect(() => {
        const read = () => setLight(isLightScheme())
        const observer = new MutationObserver(read)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style', 'class', 'data-ds-theme'],
        })
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
        mq?.addEventListener?.('change', read)
        return () => {
          observer.disconnect()
          mq?.removeEventListener?.('change', read)
        }
      }, [])

      return light
    }

/**
     * Inline device icons.
     *
     * All eight are stored once with `currentColor` fills, so a single copy
     * covers both themes — the surrounding text colour drives the glyph, which
     * is exactly how the rest of DSH's iconography behaves.
     *
     * Sized to the same 20px box as the battery glyph so the row never shifts
     * when a machine switches between laptop and desktop presentation.
     */
    const DEVICE_ICONS = {"imac": {"vb": "0 0 48 48", "body": "<path d=\"M4 6H44V28H4V6Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linejoin=\"round\"/><path d=\"M44 28V36H4V28\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M13.0909 18H10.9091C10.407 18 10 18.407 10 18.9091V21.0909C10 21.593 10.407 22 10.9091 22H13.0909C13.593 22 14 21.593 14 21.0909V18.9091C14 18.407 13.593 18 13.0909 18Z\" fill=\"currentColor\"/><path d=\"M13.0909 12H10.9091C10.407 12 10 12.407 10 12.9091V15.0909C10 15.593 10.407 16 10.9091 16H13.0909C13.593 16 14 15.593 14 15.0909V12.9091C14 12.407 13.593 12 13.0909 12Z\" fill=\"currentColor\"/><path d=\"M21.0909 18H18.9091C18.407 18 18 18.407 18 18.9091V21.0909C18 21.593 18.407 22 18.9091 22H21.0909C21.593 22 22 21.593 22 21.0909V18.9091C22 18.407 21.593 18 21.0909 18Z\" fill=\"currentColor\"/><path d=\"M21.0909 12H18.9091C18.407 12 18 12.407 18 12.9091V15.0909C18 15.593 18.407 16 18.9091 16H21.0909C21.593 16 22 15.593 22 15.0909V12.9091C22 12.407 21.593 12 21.0909 12Z\" fill=\"currentColor\"/><path d=\"M29.0909 18H26.9091C26.407 18 26 18.407 26 18.9091V21.0909C26 21.593 26.407 22 26.9091 22H29.0909C29.593 22 30 21.593 30 21.0909V18.9091C30 18.407 29.593 18 29.0909 18Z\" fill=\"currentColor\"/><path d=\"M29.0909 12H26.9091C26.407 12 26 12.407 26 12.9091V15.0909C26 15.593 26.407 16 26.9091 16H29.0909C29.593 16 30 15.593 30 15.0909V12.9091C30 12.407 29.593 12 29.0909 12Z\" fill=\"currentColor\"/><path d=\"M37.0909 12H34.9091C34.407 12 34 12.407 34 12.9091V15.0909C34 15.593 34.407 16 34.9091 16H37.0909C37.593 16 38 15.593 38 15.0909V12.9091C38 12.407 37.593 12 37.0909 12Z\" fill=\"currentColor\"/><path d=\"M20.8462 36L16 42H32L27.1538 36\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"}, "macmini": {"vb": "0 0 1024 1024", "body": "<path d=\"M264.672 62.112l480.672-0.096c65.824 0 94.944 5.984 119.584 17.344l10.336 5.184a153.184 153.184 0 0 1 63.776 63.776l5.184 10.336c11.36 24.704 17.344 53.792 17.344 119.584v467.104c0 65.824-5.984 94.944-17.344 119.584l-5.184 10.336a153.184 153.184 0 0 1-63.776 63.776l-10.336 5.184c-24.704 11.36-53.76 17.344-119.584 17.344H278.24c-65.824 0-94.944-5.984-119.584-17.344l-10.336-5.184a154.496 154.496 0 0 1-63.424-62.944l-0.416-0.832-5.184-10.336c-10.496-22.944-16.48-49.632-17.248-106.016L61.984 278.24c0-65.824 5.984-94.944 17.344-119.584l5.184-10.336a153.184 153.184 0 0 1 63.776-63.776l10.336-5.184c22.944-10.496 49.632-16.48 106.016-17.248z m13.6 78.592l-22.048 0.192-9.504 0.288-16.128 0.96c-21.856 1.792-33.44 5.504-45.184 11.808-13.536 7.168-24.32 17.952-31.296 31.072l-0.192 0.416c-6.24 11.68-9.952 23.296-11.744 45.12l-0.96 16.192-0.448 19.904v490.272l0.512 19.904 0.896 16.192c1.792 21.856 5.504 33.44 11.808 45.184 7.36 13.76 17.696 24.096 31.488 31.488 11.68 6.24 23.296 9.952 45.12 11.744l16.192 0.96 19.904 0.448 510.176-0.512 16.192-0.896c21.856-1.792 33.44-5.504 45.184-11.808 13.76-7.36 24.096-17.696 31.488-31.488 6.24-11.68 9.952-23.296 11.744-45.12l0.96-16.192 0.448-19.904V266.656l-0.512-19.904-0.896-16.192c-1.792-21.856-5.504-33.44-11.808-45.184a74.944 74.944 0 0 0-31.072-31.296l-0.416-0.192c-11.68-6.24-23.296-9.952-45.12-11.744l-16.192-0.96-19.904-0.448-478.688-0.064z m227.2 235.168a84.576 84.576 0 0 0 42.4-15.424l-0.256 0.16a99.84 99.84 0 0 0 15.104-12.8c4.096-6.4 7.104-11.488 10.112-16.736 2.752-4.704 4.8-11.008 6.848-19.2 1.504-5.984 2.656-12.192 2.656-19.392v-5.6a88.096 88.096 0 0 0-42.336 15.296c-5.536 3.904-10.496 8-15.232 12.8a121.44 121.44 0 0 0-10.144 16.704c-2.88 5.664-5.216 12.224-6.688 19.104l-0.096 0.544a83.136 83.136 0 0 0-2.304 18.528v6.048zM351.04 509.44v0.448c0 38.336 9.792 74.4 27.008 105.792l-0.576-1.152c13.152 24 24.128 41.12 35.488 50.784 11.744 9.984 22.752 14.88 33.088 14.88 21.888 0 46.816-20.256 67.264-20.256 19.456 0 39.04 20.256 59.488 20.256 11.008 0 21.152-3.904 30.976-11.136 10.592-7.84 18.848-17.504 27.04-28.928a139.52 139.52 0 0 0 9.312-15.296l0.384-0.8c5.632-10.496 12-25.376 20.256-43.584v-2.656c-30.144-11.136-51.84-41.92-51.84-75.968 0-15.936 3.648-29.984 11.36-42.528 8.192-13.28 18.592-22.496 30.976-29.344-18.592-25.184-47.68-39.488-70.432-39.488-25.6 0-61.472 18.208-72.256 18.208-10.88 0-34.24-16.704-64.96-16.704-20.096 0-46.976 8.16-67.36 30.336-13.504 14.752-19.744 37.184-23.488 63.36a204.736 204.736 0 0 0-1.696 23.744z\" fill=\"currentColor\"/>"}, "desktop-windows": {"vb": "0 0 1024 1024", "body": "<g transform=\"translate(32.0 32.0) scale(0.9375)\" fill=\"currentColor\"><path d=\"M832 0H192c-35.3 0-64 28.7-64 64v896c0 35.3 28.7 64 64 64h640c35.3 0 64-28.7 64-64V64c0-35.3-28.7-64-64-64z m-21.33 938.67H213.33V85.33h597.34v853.34z\"/><path d=\"M288 256h448c1.2 0 2.5-0.1 3.7-0.2 17.6-2 30.1-17.9 28.1-35.5-1.9-16.3-15.7-28.3-31.7-28.3H288c-17.7 0-32 14.3-32 32s14.3 32 32 32zm447.4 128H288c-17.7 0-32 14.3-32 32s14.3 32 32 32h448c1.6 0 3.3-0.1 4.9-0.4 17.5-2.7 29.4-19 26.8-36.5-2.5-16-16.4-27.4-32.3-27.1zM512 576c-70.6 0-128 57.4-128 128s57.4 128 128 128 128-57.4 128-128-57.4-128-128-128z m0 192c-35.3 0-64-28.7-64-64s28.7-64 64-64 64 28.7 64 64-28.7 64-64 64z\"/></g>"}, "laptop": {"vb": "0 0 48 48", "body": "<rect x=\"8\" y=\"8\" width=\"32\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8 28L4 41H44L40 28\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M19.9 35H28.1L30 41H18L19.9 35Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"}, "synology": {"vb": "0 0 1024 1024", "body": "<g fill=\"currentColor\"><g transform=\"translate(236.59 437.90) scale(0.14431)\"><path d=\"M39.822222 548.977778l136.533334-14.222222c8.533333 45.511111 25.6 79.644444 51.2 99.555555 25.6 22.755556 59.733333 31.288889 102.4 31.288889 45.511111 0 79.644444-8.533333 102.4-28.444444 22.755556-19.911111 34.133333-42.666667 34.133333-68.266667 0-17.066667-5.688889-31.288889-14.222222-42.666667-8.533333-11.377778-25.6-22.755556-51.2-28.444444-17.066667-5.688889-54.044444-17.066667-110.933334-31.288889-73.955556-17.066667-128-42.666667-159.288889-68.266667-42.666667-39.822222-62.577778-85.333333-62.577777-142.222222 0-34.133333 8.533333-68.266667 31.288889-99.555556 19.911111-31.288889 48.355556-54.044444 88.177777-71.111111 36.977778-17.066667 82.488889-22.755556 136.533334-22.755555 88.177778 0 153.6 19.911111 196.266666 56.888889 42.666667 39.822222 68.266667 91.022222 68.266667 153.6l-142.222222 5.688889c-5.688889-34.133333-19.911111-59.733333-39.822222-76.8-19.911111-17.066667-48.355556-22.755556-88.177778-22.755556-39.822222 0-73.955556 8.533333-96.711111 25.6-14.222222 14.222222-19.911111 28.444444-19.911111 45.511111 0 17.066667 5.688889 31.288889 19.911111 42.666667 17.066667 14.222222 59.733333 31.288889 128 45.511111 68.266667 17.066667 119.466667 34.133333 150.755555 51.2 31.288889 17.066667 59.733333 39.822222 76.8 71.111111 17.066667 28.444444 28.444444 68.266667 28.444445 110.933333 0 39.822222-11.377778 76.8-34.133334 113.777778-22.755556 34.133333-54.044444 59.733333-93.866666 76.8-39.822222 17.066667-91.022222 25.6-150.755556 25.6-88.177778 0-156.444444-19.911111-201.955555-62.577778-48.355556-36.977778-73.955556-96.711111-85.333334-176.355555z\"/><path d=\"M588.8 270.222222h142.222222l119.466667 358.4L967.111111 270.222222h136.533333l-176.355555 486.4-31.288889 88.177778c-11.377778 28.444444-22.755556 51.2-34.133333 68.266667-11.377778 17.066667-22.755556 28.444444-36.977778 36.977777-14.222222 8.533333-31.288889 17.066667-51.2 22.755556-19.911111 5.688889-42.666667 8.533333-68.266667 8.533333-25.6 0-51.2-2.844444-76.8-8.533333l-11.377778-105.244444c19.911111 5.688889 39.822222 5.688889 56.888889 5.688888 31.288889 0 54.044444-8.533333 68.266667-28.444444s25.6-42.666667 34.133333-71.111111L588.8 270.222222zM1570.133333 776.533333h-133.688889v-258.844444c0-54.044444-2.844444-88.177778-8.533333-105.244445-5.688889-17.066667-14.222222-28.444444-28.444444-36.977777-14.222222-8.533333-28.444444-14.222222-45.511111-14.222223-22.755556 0-45.511111 5.688889-62.577778 19.911112-19.911111 11.377778-31.288889 28.444444-36.977778 51.2-5.688889 19.911111-11.377778 59.733333-11.377778 116.622222v227.555555H1109.333333V270.222222h122.311111v73.955556c45.511111-56.888889 99.555556-82.488889 167.822223-82.488889 28.444444 0 56.888889 5.688889 82.488889 14.222222 25.6 11.377778 42.666667 22.755556 56.888888 39.822222 11.377778 17.066667 19.911111 34.133333 25.6 56.888889 5.688889 19.911111 8.533333 51.2 8.533334 91.022222l-2.844445 312.888889z\"/><path d=\"M1570.133333 517.688889c0-45.511111 11.377778-88.177778 34.133334-128 22.755556-42.666667 54.044444-73.955556 93.866666-93.866667 39.822222-22.755556 85.333333-31.288889 133.688889-31.288889 76.8 0 139.377778 25.6 187.733334 73.955556 48.355556 48.355556 73.955556 113.777778 73.955555 187.733333 0 76.8-25.6 139.377778-73.955555 190.577778-48.355556 51.2-110.933333 76.8-187.733334 76.8-45.511111 0-91.022222-11.377778-133.688889-31.288889-42.666667-19.911111-73.955556-51.2-96.711111-91.022222-19.911111-45.511111-31.288889-93.866667-31.288889-153.6z m136.533334 8.533333c0 51.2 11.377778 88.177778 36.977777 116.622222 22.755556 25.6 54.044444 39.822222 88.177778 39.822223 34.133333 0 65.422222-14.222222 88.177778-39.822223 22.755556-25.6 34.133333-65.422222 34.133333-116.622222 0-51.2-11.377778-88.177778-34.133333-113.777778a116.622222 116.622222 0 0 0-88.177778-39.822222c-34.133333 0-65.422222 14.222222-88.177778 39.822222-25.6 22.755556-36.977778 62.577778-36.977777 113.777778z\"/><path d=\"M2255.644444 11.377778v654.222222c0 31.288889 2.844444 51.2 5.688889 62.577778 5.688889 11.377778 11.377778 17.066667 19.911111 22.755555 8.533333 5.688889 25.6 8.533333 51.2 8.533334v19.911111h-241.777777v-19.911111c22.755556 0 36.977778-2.844444 45.511111-8.533334 8.533333-5.688889 14.222222-11.377778 19.911111-22.755555 5.688889-11.377778 5.688889-31.288889 5.688889-62.577778V219.022222c0-56.888889 0-91.022222-2.844445-102.4-2.844444-14.222222-5.688889-22.755556-11.377777-25.6-5.688889-5.688889-11.377778-8.533333-19.911112-8.533333-8.533333 0-19.911111 2.844444-34.133333 8.533333l-8.533333-19.911111L2230.044444 11.377778h25.6zM2574.222222 270.222222c73.955556 0 133.688889 28.444444 179.2 85.333334 36.977778 48.355556 56.888889 102.4 56.888889 167.822222 0 45.511111-11.377778 88.177778-31.288889 133.688889-19.911111 45.511111-51.2 79.644444-88.177778 102.4-36.977778 22.755556-79.644444 34.133333-125.155555 34.133333-73.955556 0-133.688889-28.444444-176.355556-88.177778-36.977778-48.355556-56.888889-105.244444-56.888889-167.822222 0-45.511111 11.377778-91.022222 34.133334-133.688889 22.755556-45.511111 51.2-76.8 88.177778-99.555555 39.822222-25.6 79.644444-34.133333 119.466666-34.133334z m-17.066666 34.133334c-19.911111 0-36.977778 5.688889-56.888889 17.066666-19.911111 11.377778-34.133333 31.288889-45.511111 59.733334-11.377778 28.444444-17.066667 65.422222-17.066667 108.088888 0 71.111111 14.222222 133.688889 42.666667 184.888889 28.444444 51.2 65.422222 76.8 113.777777 76.8 34.133333 0 62.577778-14.222222 85.333334-42.666666 22.755556-28.444444 34.133333-76.8 34.133333-147.911111 0-88.177778-19.911111-156.444444-56.888889-204.8-28.444444-34.133333-59.733333-51.2-99.555555-51.2zM2921.244444 597.333333c-31.288889-14.222222-54.044444-34.133333-68.266666-62.577777-17.066667-25.6-22.755556-54.044444-22.755556-88.177778 0-48.355556 17.066667-91.022222 54.044445-125.155556 36.977778-34.133333 82.488889-54.044444 142.222222-54.044444 45.511111 0 88.177778 11.377778 122.311111 34.133333h133.688889c2.844444 0 2.844444 2.844444 5.688889 5.688889s2.844444 8.533333 2.844444 17.066667 0 17.066667-2.844444 19.911111c0 2.844444-2.844444 2.844444-5.688889 2.844444s-11.377778 2.844444-28.444445 2.844445h-65.422222c19.911111 25.6 31.288889 59.733333 31.288889 99.555555 0 45.511111-17.066667 85.333333-54.044444 116.622222-34.133333 31.288889-82.488889 48.355556-142.222223 48.355556-25.6 0-48.355556-2.844444-73.955555-11.377778-14.222222 14.222222-25.6 25.6-31.288889 36.977778-5.688889 11.377778-8.533333 19.911111-8.533333 25.6 0 5.688889 2.844444 11.377778 8.533333 17.066667 5.688889 5.688889 17.066667 8.533333 34.133333 11.377777 8.533333 2.844444 34.133333 2.844444 73.955556 5.688889 73.955556 2.844444 122.311111 5.688889 142.222222 8.533334 34.133333 5.688889 59.733333 17.066667 79.644445 36.977777 19.911111 19.911111 28.444444 45.511111 28.444444 73.955556 0 39.822222-19.911111 76.8-56.888889 113.777778-54.044444 51.2-128 76.8-219.022222 76.8-68.266667 0-128-14.222222-173.511111-45.511111-25.6-17.066667-39.822222-36.977778-39.822222-56.888889 0-8.533333 2.844444-17.066667 5.688888-25.6 5.688889-14.222222 17.066667-31.288889 36.977778-54.044445 2.844444-2.844444 19.911111-22.755556 54.044445-56.888889-17.066667-11.377778-31.288889-22.755556-39.822223-31.288888-8.533333-8.533333-11.377778-19.911111-11.377777-31.288889 0-11.377778 5.688889-28.444444 14.222222-45.511111 14.222222-11.377778 36.977778-36.977778 73.955555-65.422223z m-5.688888 179.2c-17.066667 17.066667-28.444444 34.133333-36.977778 51.2-8.533333 14.222222-11.377778 28.444444-11.377778 42.666667 0 17.066667 11.377778 31.288889 31.288889 45.511111 36.977778 22.755556 88.177778 34.133333 156.444444 34.133333 65.422222 0 110.933333-11.377778 142.222223-34.133333 31.288889-22.755556 45.511111-45.511111 45.511111-71.111111 0-17.066667-8.533333-31.288889-28.444445-39.822222-19.911111-8.533333-56.888889-11.377778-110.933333-14.222222-82.488889-2.844444-145.066667-8.533333-187.733333-14.222223z m96.711111-480.711111c-25.6 0-48.355556 11.377778-65.422223 31.288889-17.066667 19.911111-25.6 51.2-25.6 96.711111 0 56.888889 11.377778 99.555556 36.977778 130.844445 19.911111 22.755556 42.666667 34.133333 71.111111 34.133333s48.355556-11.377778 65.422223-31.288889c17.066667-19.911111 25.6-51.2 25.6-93.866667 0-56.888889-11.377778-99.555556-36.977778-133.688888-17.066667-22.755556-42.666667-34.133333-71.111111-34.133334zM3299.555556 284.444444h230.4v19.911112h-11.377778c-17.066667 0-28.444444 2.844444-36.977778 11.377777-8.533333 8.533333-11.377778 17.066667-11.377778 25.6 0 14.222222 5.688889 34.133333 17.066667 56.888889l119.466667 250.311111 110.933333-273.066666c5.688889-14.222222 8.533333-28.444444 8.533333-45.511111 0-5.688889-2.844444-11.377778-2.844444-14.222223-2.844444-2.844444-8.533333-8.533333-14.222222-8.533333-5.688889-2.844444-17.066667-2.844444-31.288889-2.844444V284.444444h159.288889v19.911112c-14.222222 0-22.755556 5.688889-31.288889 8.533333-8.533333 5.688889-14.222222 11.377778-22.755556 22.755555-2.844444 5.688889-8.533333 19.911111-17.066667 42.666667l-199.111111 492.088889c-19.911111 48.355556-45.511111 82.488889-76.8 108.088889-31.288889 25.6-62.577778 36.977778-91.022222 36.977778-19.911111 0-39.822222-5.688889-51.2-17.066667-14.222222-11.377778-19.911111-25.6-19.911111-42.666667 0-14.222222 5.688889-25.6 14.222222-36.977777 8.533333-8.533333 22.755556-14.222222 39.822222-14.222223 11.377778 0 28.444444 2.844444 48.355556 11.377778 14.222222 5.688889 22.755556 8.533333 28.444444 8.533333 11.377778 0 22.755556-5.688889 34.133334-17.066666 11.377778-11.377778 25.6-31.288889 39.822222-62.577778l34.133333-85.333333-176.355555-369.777778c-5.688889-11.377778-14.222222-25.6-25.6-42.666667-8.533333-11.377778-17.066667-19.911111-22.755556-25.6-8.533333-5.688889-22.755556-11.377778-39.822222-14.222222V284.444444zM3837.155556 250.311111V150.755556h42.666666c8.533333 0 14.222222 0 19.911111 2.844444 5.688889 2.844444 8.533333 5.688889 11.377778 8.533333 2.844444 5.688889 2.844444 8.533333 2.844445 14.222223 0 8.533333-2.844444 14.222222-5.688889 17.066666-2.844444 5.688889-11.377778 8.533333-19.911111 8.533334 2.844444 2.844444 5.688889 2.844444 8.533333 5.688888l11.377778 11.377778 17.066666 25.6h-17.066666l-14.222223-19.911111c-2.844444-5.688889-5.688889-11.377778-8.533333-14.222222l-5.688889-5.688889c-2.844444 0-2.844444-2.844444-5.688889-2.844444h-22.755555v42.666666h-14.222222z m11.377777-54.044444h28.444445c5.688889 0 11.377778 0 14.222222-2.844445 2.844444 0 5.688889-2.844444 8.533333-5.688889 2.844444-2.844444 2.844444-5.688889 2.844445-8.533333 0-5.688889-2.844444-8.533333-5.688889-11.377778-2.844444-2.844444-8.533333-5.688889-17.066667-5.688889h-31.288889v34.133334z\"/></g></g><path d=\"M264.672 62.112l480.672-0.096c65.824 0 94.944 5.984 119.584 17.344l10.336 5.184a153.184 153.184 0 0 1 63.776 63.776l5.184 10.336c11.36 24.704 17.344 53.792 17.344 119.584v467.104c0 65.824-5.984 94.944-17.344 119.584l-5.184 10.336a153.184 153.184 0 0 1-63.776 63.776l-10.336 5.184c-24.704 11.36-53.76 17.344-119.584 17.344H278.24c-65.824 0-94.944-5.984-119.584-17.344l-10.336-5.184a154.496 154.496 0 0 1-63.424-62.944l-0.416-0.832-5.184-10.336c-10.496-22.944-16.48-49.632-17.248-106.016L61.984 278.24c0-65.824 5.984-94.944 17.344-119.584l5.184-10.336a153.184 153.184 0 0 1 63.776-63.776l10.336-5.184c22.944-10.496 49.632-16.48 106.016-17.248z m13.6 78.592l-22.048 0.192-9.504 0.288-16.128 0.96c-21.856 1.792-33.44 5.504-45.184 11.808-13.536 7.168-24.32 17.952-31.296 31.072l-0.192 0.416c-6.24 11.68-9.952 23.296-11.744 45.12l-0.96 16.192-0.448 19.904v490.272l0.512 19.904 0.896 16.192c1.792 21.856 5.504 33.44 11.808 45.184 7.36 13.76 17.696 24.096 31.488 31.488 11.68 6.24 23.296 9.952 45.12 11.744l16.192 0.96 19.904 0.448 510.176-0.512 16.192-0.896c21.856-1.792 33.44-5.504 45.184-11.808 13.76-7.36 24.096-17.696 31.488-31.488 6.24-11.68 9.952-23.296 11.744-45.12l0.96-16.192 0.448-19.904V266.656l-0.512-19.904-0.896-16.192c-1.792-21.856-5.504-33.44-11.808-45.184a74.944 74.944 0 0 0-31.072-31.296l-0.416-0.192c-11.68-6.24-23.296-9.952-45.12-11.744l-16.192-0.96-19.904-0.448-478.688-0.064z\" fill=\"currentColor\" fill-rule=\"evenodd\"/>"}, "zspace": {"vb": "0 0 1024 1024", "body": "<g fill=\"currentColor\"><g transform=\"translate(110.25 131.60) scale(0.73994)\"><path d=\"M505.6512 494.08L408.1664 437.248V285.3888l291.7376 169.8304 119.7568-73.7792-407.4496-237.6192-120.064 73.984V512l93.696 55.8592 119.808-73.7792zM580.352 534.1184l97.4336 56.832v151.8592l-291.6864-169.8304-119.7568 73.7792 407.4496 237.6192 120.064-73.984v-294.1952l-93.696-55.8592-119.808 73.7792z\"/></g></g><path d=\"M264.672 62.112l480.672-0.096c65.824 0 94.944 5.984 119.584 17.344l10.336 5.184a153.184 153.184 0 0 1 63.776 63.776l5.184 10.336c11.36 24.704 17.344 53.792 17.344 119.584v467.104c0 65.824-5.984 94.944-17.344 119.584l-5.184 10.336a153.184 153.184 0 0 1-63.776 63.776l-10.336 5.184c-24.704 11.36-53.76 17.344-119.584 17.344H278.24c-65.824 0-94.944-5.984-119.584-17.344l-10.336-5.184a154.496 154.496 0 0 1-63.424-62.944l-0.416-0.832-5.184-10.336c-10.496-22.944-16.48-49.632-17.248-106.016L61.984 278.24c0-65.824 5.984-94.944 17.344-119.584l5.184-10.336a153.184 153.184 0 0 1 63.776-63.776l10.336-5.184c22.944-10.496 49.632-16.48 106.016-17.248z m13.6 78.592l-22.048 0.192-9.504 0.288-16.128 0.96c-21.856 1.792-33.44 5.504-45.184 11.808-13.536 7.168-24.32 17.952-31.296 31.072l-0.192 0.416c-6.24 11.68-9.952 23.296-11.744 45.12l-0.96 16.192-0.448 19.904v490.272l0.512 19.904 0.896 16.192c1.792 21.856 5.504 33.44 11.808 45.184 7.36 13.76 17.696 24.096 31.488 31.488 11.68 6.24 23.296 9.952 45.12 11.744l16.192 0.96 19.904 0.448 510.176-0.512 16.192-0.896c21.856-1.792 33.44-5.504 45.184-11.808 13.76-7.36 24.096-17.696 31.488-31.488 6.24-11.68 9.952-23.296 11.744-45.12l0.96-16.192 0.448-19.904V266.656l-0.512-19.904-0.896-16.192c-1.792-21.856-5.504-33.44-11.808-45.184a74.944 74.944 0 0 0-31.072-31.296l-0.416-0.192c-11.68-6.24-23.296-9.952-45.12-11.744l-16.192-0.96-19.904-0.448-478.688-0.064z\" fill=\"currentColor\" fill-rule=\"evenodd\"/>"}, "ugreen": {"vb": "0 0 1024 1024", "body": "<g fill=\"currentColor\"><g transform=\"translate(238.00 466.84) scale(0.45667)\"><g transform=\"matrix(18.018018,0,0,18.084568,0,-0.565143)\"><path d=\"M64.5,0.2L64.5,7.8L60.3,0.2L57.5,0.2L57.5,10.8L59.6,10.8L59.6,3.1L63.9,10.8L66.6,10.8L66.6,0.2L64.5,0.2Z\"/><path d=\"M33.5,3.3C33.5,1.6 32.1,0.2 30.4,0.2L24.6,0.2L24.6,10.8L26.8,10.8L26.8,2L30.1,2C30.8,2 31.4,2.6 31.4,3.3C31.4,4 30.8,4.6 30.1,4.6L27.7,4.6L31.3,10.8L33.7,10.8L31.1,6.4C32.5,6.1 33.5,4.8 33.5,3.3Z\"/><path d=\"M7,6.2C7,7.5 5.9,8.6 4.6,8.6C3.3,8.6 2.2,7.5 2.2,6.2L2.2,0.2L0,0.2L0,6.4C0,9 2.1,11 4.7,11C7.3,11 9.4,8.9 9.4,6.4L9.4,0.2L7.2,0.2L7.2,6.2L7,6.2Z\"/><path d=\"M16.9,4.6L16.9,6.5L19.9,6.5C19.8,7.1 19.5,7.7 19,8.1C18.4,8.6 17.5,8.9 16.6,8.9C14.9,8.8 13.6,7.4 13.5,5.7C13.5,3.8 15,2.3 16.8,2.3C17.6,2.3 18.4,2.6 19,3.1L21.8,3.1C21.3,1.8 20.3,0.9 19,0.4C16.4,-0.6 13.4,0.5 12,2.9C11.9,3.1 11.8,3.3 11.7,3.5C10.6,6.3 11.9,9.6 14.8,10.7C17.3,11.7 20.1,10.7 21.5,8.6L21.5,8.5C22,7.7 22.2,6.8 22.2,5.8C22.2,5.4 22.2,5 22.1,4.6L16.9,4.6Z\"/><path d=\"M35.7,10.8L44.3,10.8L44.3,8.9L37.9,8.9L37.9,6.5L43.3,6.5L43.3,4.6L37.9,4.6L37.9,2.2L44.3,2.2L44.3,0.3L35.8,0.3L35.7,10.8Z\"/><path d=\"M46.6,10.8L55.1,10.8L55.1,8.9L48.7,8.9L48.7,6.5L54.1,6.5L54.1,4.6L48.7,4.6L48.7,2.2L55.1,2.2L55.1,0.3L46.6,0.3L46.6,10.8Z\"/></g></g></g><path d=\"M264.672 62.112l480.672-0.096c65.824 0 94.944 5.984 119.584 17.344l10.336 5.184a153.184 153.184 0 0 1 63.776 63.776l5.184 10.336c11.36 24.704 17.344 53.792 17.344 119.584v467.104c0 65.824-5.984 94.944-17.344 119.584l-5.184 10.336a153.184 153.184 0 0 1-63.776 63.776l-10.336 5.184c-24.704 11.36-53.76 17.344-119.584 17.344H278.24c-65.824 0-94.944-5.984-119.584-17.344l-10.336-5.184a154.496 154.496 0 0 1-63.424-62.944l-0.416-0.832-5.184-10.336c-10.496-22.944-16.48-49.632-17.248-106.016L61.984 278.24c0-65.824 5.984-94.944 17.344-119.584l5.184-10.336a153.184 153.184 0 0 1 63.776-63.776l10.336-5.184c22.944-10.496 49.632-16.48 106.016-17.248z m13.6 78.592l-22.048 0.192-9.504 0.288-16.128 0.96c-21.856 1.792-33.44 5.504-45.184 11.808-13.536 7.168-24.32 17.952-31.296 31.072l-0.192 0.416c-6.24 11.68-9.952 23.296-11.744 45.12l-0.96 16.192-0.448 19.904v490.272l0.512 19.904 0.896 16.192c1.792 21.856 5.504 33.44 11.808 45.184 7.36 13.76 17.696 24.096 31.488 31.488 11.68 6.24 23.296 9.952 45.12 11.744l16.192 0.96 19.904 0.448 510.176-0.512 16.192-0.896c21.856-1.792 33.44-5.504 45.184-11.808 13.76-7.36 24.096-17.696 31.488-31.488 6.24-11.68 9.952-23.296 11.744-45.12l0.96-16.192 0.448-19.904V266.656l-0.512-19.904-0.896-16.192c-1.792-21.856-5.504-33.44-11.808-45.184a74.944 74.944 0 0 0-31.072-31.296l-0.416-0.192c-11.68-6.24-23.296-9.952-45.12-11.744l-16.192-0.96-19.904-0.448-478.688-0.064z\" fill=\"currentColor\" fill-rule=\"evenodd\"/>"}, "fnos": {"vb": "0 0 1024 1024", "body": "<g transform=\"translate(212.91 223.99) scale(0.58360)\"><path d=\"M886.869333 129.664c0-12.629333 56.192 50.474667 73.216 80.768 13.226667 25.258667 18.346667 43.52 20.224 81.408 2.517333 43.562667 1.28 51.157333-13.226666 75.776a123.392 123.392 0 0 1-43.562667 42.922667l-27.178667 15.786666-261.930666 3.114667-261.888 3.157333-1.92 148.352c-0.64 81.408 0 154.624 1.92 162.816 3.114667 13.226667 6.912 14.506667 33.408 12.629334l29.653333-1.92 3.797333-46.037334c2.56-38.485333 6.314667-48.64 20.224-63.146666 14.506667-14.506667 23.338667-17.066667 68.778667-20.181334l52.352-3.157333 1.92-37.888c1.92-44.16 9.472-62.464 30.933333-71.936 18.304-8.192 254.122667-9.472 254.378667-1.28 0 10.752-58.709333 58.709333-90.24 73.856-18.346667 8.234667-46.08 17.066667-61.866667 18.944l-29.696 3.797333-2.517333 43.52c-1.877333 34.730667-5.077333 46.08-17.706667 59.306667-13.866667 14.506667-18.901333 15.829333-70.656 15.829333H539.733333v50.517334c0 46.08-1.877333 52.352-15.786666 66.218666-14.506667 15.146667-17.664 15.786667-106.666667 15.786667H325.802667l-22.741334-19.541333c-11.989333-10.752-25.216-29.696-29.013333-42.325334-4.437333-15.146667-5.674667-87.722667-4.437333-207.616l1.877333-183.68 18.944-27.136c10.709333-14.506667 30.293333-32.853333 44.202667-39.765333 23.978667-12.629333 35.968-13.269333 273.92-15.146667 273.237333-2.56 265.728-1.28 290.986666-42.24 15.744-25.898667 15.744-65.066667 0-110.506666a358.186667 358.186667 0 0 1-12.672-41.002667z m-747.264-1.28c1.237333 1.28-3.157333 18.346667-10.112 37.888-13.866667 40.405333-16.384 83.925333-5.034666 108.544 9.472 21.461333 41.045333 40.405333 77.013333 44.8 15.786667 2.56 29.013333 5.077333 29.013333 6.314667 0 1.28-6.954667 11.989333-15.146666 24.618666-8.832 12.629333-17.706667 35.370667-20.224 51.157334-3.157333 23.936-5.674667 27.733333-19.541334 27.733333-59.306667 0-114.901333-37.845333-128.170666-88.32C32.256 285.568 53.76 216.746667 102.4 163.712c19.541333-20.821333 35.968-36.565333 37.248-35.328z\" fill=\"currentColor\"/></g><path d=\"M264.672 62.112l480.672-0.096c65.824 0 94.944 5.984 119.584 17.344l10.336 5.184a153.184 153.184 0 0 1 63.776 63.776l5.184 10.336c11.36 24.704 17.344 53.792 17.344 119.584v467.104c0 65.824-5.984 94.944-17.344 119.584l-5.184 10.336a153.184 153.184 0 0 1-63.776 63.776l-10.336 5.184c-24.704 11.36-53.76 17.344-119.584 17.344H278.24c-65.824 0-94.944-5.984-119.584-17.344l-10.336-5.184a154.496 154.496 0 0 1-63.424-62.944l-0.416-0.832-5.184-10.336c-10.496-22.944-16.48-49.632-17.248-106.016L61.984 278.24c0-65.824 5.984-94.944 17.344-119.584l5.184-10.336a153.184 153.184 0 0 1 63.776-63.776l10.336-5.184c22.944-10.496 49.632-16.48 106.016-17.248z m13.6 78.592l-22.048 0.192-9.504 0.288-16.128 0.96c-21.856 1.792-33.44 5.504-45.184 11.808-13.536 7.168-24.32 17.952-31.296 31.072l-0.192 0.416c-6.24 11.68-9.952 23.296-11.744 45.12l-0.96 16.192-0.448 19.904v490.272l0.512 19.904 0.896 16.192c1.792 21.856 5.504 33.44 11.808 45.184 7.36 13.76 17.696 24.096 31.488 31.488 11.68 6.24 23.296 9.952 45.12 11.744l16.192 0.96 19.904 0.448 510.176-0.512 16.192-0.896c21.856-1.792 33.44-5.504 45.184-11.808 13.76-7.36 24.096-17.696 31.488-31.488 6.24-11.68 9.952-23.296 11.744-45.12l0.96-16.192 0.448-19.904V266.656l-0.512-19.904-0.896-16.192c-1.792-21.856-5.504-33.44-11.808-45.184a74.944 74.944 0 0 0-31.072-31.296l-0.416-0.192c-11.68-6.24-23.296-9.952-45.12-11.744l-16.192-0.96-19.904-0.448-478.688-0.064z\" fill=\"currentColor\" fill-rule=\"evenodd\"/>"}}

    function DeviceIcon({ kind, color }) {
      const icon = DEVICE_ICONS[kind]
      if (icon === undefined) return null
      return h('svg', {
        width: 20,
        height: 20,
        viewBox: icon.vb,
        'aria-hidden': true,
        focusable: false,
        style: {
          flexShrink: 0,
          display: 'block',
          color,
        },
        dangerouslySetInnerHTML: { __html: icon.body },
      })
    }

    /**
     * Hide the badge whenever something else claims its part of the row.
     *
     * Other footer plugins (the mobile gateway's "reconnecting…" pill, the IM
     * bridge, …) can mount into this same row while connecting or
     * disconnecting. When that happens our absolutely-positioned badge would
     * draw on top of their control and both become unreadable.
     *
     * Rather than guess which plugin it is, measure: if any sibling inside the
     * account row overlaps the badge's box, the badge is hidden. That covers
     * every present and future plugin, and it clears itself the moment the
     * other element goes away.
     */
    function useCrowdedOut(ref) {
      const [crowded, setCrowded] = useState(false)

      useEffect(() => {
        const node = ref.current
        if (!node) return
        const row = node.parentElement?.parentElement?.parentElement
        if (!row) return

        // Everything between the badge and the account row is our own slot
        // machinery — wrapper divs, the slot container, the notifications
        // layer. They always overlap the badge, so they must be skipped or
        // the check would never clear.
        const ownAncestors = new Set()
        for (let el = node; el && el !== row; el = el.parentElement) ownAncestors.add(el)

        let frame = 0
        const measure = () => {
          frame = 0
          const box = node.getBoundingClientRect()
          if (box.width === 0) return

          let clash = false
          for (const child of row.querySelectorAll('*')) {
            if (ownAncestors.has(child) || node.contains(child)) continue
            // Skip anything that merely wraps the badge (an ancestor of it).
            if (child.contains(node)) continue
            const r = child.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            // Only compact, self-contained widgets count as a clash. The
            // account button, its anchor span and other row-level wrappers all
            // span the full row and are supposed to sit under the badge —
            // a status pill or reconnect button is much narrower than that.
            if (r.width > box.width * 1.2) continue
            const overlapsX = r.right > box.left + 2 && r.left < box.right - 2
            const overlapsY = r.bottom > box.top + 2 && r.top < box.bottom - 2
            if (overlapsX && overlapsY) {
              clash = true
              break
            }
          }
          setCrowded(clash)
        }
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure)
        }

        schedule()
        const observer = new MutationObserver(schedule)
        // Observe the whole sidebar footer, not just the account row: a new
        // status pill may be inserted as a sibling *above* the row, which
        // would never fire a mutation on the row itself.
        observer.observe(row.parentElement ?? row, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        })
        const sizes = new ResizeObserver(schedule)
        sizes.observe(row)
        if (row.parentElement) sizes.observe(row.parentElement)
        window.addEventListener('resize', schedule)
        // Belt and braces: poll a few times right after mount, since some
        // widgets appear on a timer rather than through a DOM mutation we see.
        const timers = [120, 400, 900, 1600].map((ms) => setTimeout(schedule, ms))

        return () => {
          if (frame) cancelAnimationFrame(frame)
          observer.disconnect()
          sizes.disconnect()
          window.removeEventListener('resize', schedule)
          timers.forEach(clearTimeout)
        }
      }, [ref])

      return crowded
    }

    /**
     * Pick how much label the row can afford.
     *
     * The user's nickname must never be truncated by us, so the badge yields
     * instead. We measure what is actually free to the left of the badge's
     * right-aligned box and step down through three levels:
     *
     *   2 — full label ("MacBook Air M1")
     *   1 — family only ("MacBook", "iMac", "群晖")
     *   0 — glyph only, no text at all
     *
     * A hidden measuring span holds the widest candidate budget so the choice
     * is a real text-metrics comparison rather than a character-count guess.
     */
    function useFitLevel(ref, full, brief) {
      const [level, setLevel] = useState(2)

      useEffect(() => {
        const node = ref.current
        if (!node) return
        let frame = 0

        const measure = () => {
          frame = 0
          const row = node.parentElement?.parentElement?.parentElement
          if (!row) return

          const rowBox = row.getBoundingClientRect()
          const style = getComputedStyle(node)

          const ctx = document.createElement('canvas').getContext('2d')
          ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
          // Glyph (26) + flex gap (4) + the widest realistic percentage ("100%")
          const glyphAndPercent = 26 + 4 + 42
          const widthOf = (t) => (t === null ? 0 : ctx.measureText(t).width)

          const fullNeed = widthOf(full) + 3 + glyphAndPercent
          const briefNeed = widthOf(brief) + 3 + glyphAndPercent

          // Never touch the nickname. The host already gives it `flex:1` +
          // `min-width:0` + `text-overflow:ellipsis`, so it manages its own
          // space; our only job is to ask for as little as possible.
          //
          // The row is fixed-width, so decide by how much room the badge can
          // take before the nickname would have to shrink below a readable
          // width. 110px is roughly six CJK characters — below that the name
          // is not identifiable anyway, so we give the space back to it.
          // Keep enough room for the avatar + the shortest identifiable name
          // (roughly two CJK characters ≈ 60px) before we claim anything.
          const MIN_NAME = 80
          const available = rowBox.width - MIN_NAME

          let level = 2
          if (available < fullNeed) level = 1
          if (available < briefNeed) level = 0

          setLevel(level)
        }

        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure)
        }
        schedule()
        const observer = new MutationObserver(schedule)
        const row = node.parentElement?.parentElement?.parentElement
        if (row?.parentElement) {
          observer.observe(row.parentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          })
        }
        const sizes = new ResizeObserver(schedule)
        if (row) sizes.observe(row)
        window.addEventListener('resize', schedule)
        const timers = [80, 300, 800, 1600].map((ms) => setTimeout(schedule, ms))

        return () => {
          if (frame) cancelAnimationFrame(frame)
          observer.disconnect()
          sizes.disconnect()
          window.removeEventListener('resize', schedule)
          timers.forEach(clearTimeout)
        }
      }, [ref, full, brief])

      return level
    }

    function DeviceBadge(props) {
      const { state, failed } = useBatteryStatus()
      const text = props?.t ?? TEXT.zh

      // Three-step label degradation, decided by measurement (see the fit
      // effect below): full label → short family name → glyph only.
      const fullModel = state?.modelShort || state?.modelLabel || state?.modelId || null
      // Fall back to deriving the family name locally when the host has not
      // been restarted since `modelBrief` was added.
      const briefModel =
        state?.modelBrief ??
        (state
          ? state.kind === 'nas'
            ? { synology: '群晖', zspace: '极空间', ugreen: '绿联', fnos: '飞牛' }[state.nasBrand] ?? null
            : state.kind === 'desktop-windows'
              ? 'Windows'
              : /^(MacBook|iMac|Mac mini|Mac Studio|Mac Pro)/.exec(fullModel ?? '')?.[1] ?? null
          : null)

      const rootRef = useRef(null)
      const crowded = useCrowdedOut(rootRef)
      const fitLevel = useFitLevel(rootRef, fullModel, briefModel)

      const percent = state && typeof state.percent === 'number' ? state.percent : null
      const light = useLightScheme()
      const color = toneFor(state)

      // Level 2 → full name, 1 → family name, 0 → no text at all.
      const model = fitLevel === 2 ? fullModel : fitLevel === 1 ? briefModel : null
      const showText = model !== null && model !== undefined && model !== ''
      const mode = modeFor(state)
      const remaining = formatRemaining(state?.remainingMinutes)

      // Only laptops carry a battery reading. Desktops and NAS boxes get a
      // device glyph instead — showing "—%" on a Mac mini would be noise.
      const baseKind = state?.kind ?? (state?.hasBattery === false ? 'macmini' : 'laptop')
      const isLaptop = baseKind === 'laptop'
      // NAS hosts report kind 'nas' plus a brand; fall back to the Synology
      // glyph when the vendor string was not recognised.
      const kind =
        baseKind === 'nas'
          ? (state?.nasBrand ?? 'synology')
          : baseKind

      let status = null
      if (failed) status = text.unavailable
      else if (state === null) status = null
      else if (!state.hasBattery) status = null
      else if (state.charged) status = text.charged
      else if (state.charging) status = remaining === null ? text.charging : `${text.charging} ${remaining}`
      else if (state.acAttached) status = text.acAttached
      else if (remaining !== null) status = `${text.remaining} ${remaining}`

      // The tooltip is the escape hatch for a downgraded label: whatever the
      // row had to shorten, hovering always reveals the full hardware name.
      //
      // Order: full marketing name → battery state → the raw model identifier.
      // The raw id only appears when it adds information (i.e. differs from
      // the friendly label), so Macs show "MacBook Air (M1, 2020) ·
      // MacBookAir10,1" while NAS boxes show their single product string once.
      const friendlyName = state?.modelLabel ?? state?.modelId ?? fullModel ?? null
      const rawId = state?.modelId ?? null
      const showRawId =
        rawId !== null && friendlyName !== null && rawId !== friendlyName
      const tooltip = [
        friendlyName ?? text.unknown,
        isLaptop && percent !== null ? `${percent}%` : null,
        isLaptop ? status : null,
        showRawId ? rawId : null,
      ]
        .filter(Boolean)
        .join(' · ')

      // Apple system font stack — matches the rest of the macOS UI rather than
      // inheriting the panel's font.
      const appleFont =
        '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", sans-serif'

      return h(
        'div',
        {
          'data-device-badge': '',
          ref: rootRef,
          title: tooltip,
          'aria-label': tooltip,
          style: {
            // Pin to the right edge of the row instead of filling it, so the
            // avatar and account name keep their own space on the left.
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 4,
            // Width is driven purely by content: the badge shrinks itself via
            // useFitLevel rather than being clipped by a percentage cap, so
            // its measured width is always the width it actually needs.
            width: 'max-content',
            maxWidth: '100%',
            padding: '0 10px 0 4px',
            boxSizing: 'border-box',
            fontFamily: appleFont,
            // One step smaller than the account label (14px): the badge is
            // secondary information and a smaller size also keeps the row
            // comfortable on narrow screens.
            fontSize: 12,
            lineHeight: '16px',
            letterSpacing: '-0.01em',
            color: 'var(--dsw-alias-label-secondary, #666)',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            // Must accept hover, otherwise the browser never shows the native
            // `title` tooltip (the whole reason a downgraded label stays
            // explainable). The badge sits at the row's right edge, clear of
            // the account button, so this does not steal menu clicks.
            pointerEvents: 'auto',
            cursor: 'default',
            // Hidden but still laid out: `visibility` keeps the element's box
            // measurable, so the overlap check can tell when the row frees up
            // again. (Returning null would detach it and freeze the state.)
            visibility: crowded ? 'hidden' : 'visible',
            WebkitFontSmoothing: 'antialiased',
            MozOsgrFontSmoothing: 'grayscale',
          },
        },
        showText &&
          h(
          'span',
          {
            style: {
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              // Same `color` as the percentage and the glyph, so all three
              // render in exactly the same shade.
              color,
              // Match the percentage's theme-aware weight — see the comment
              // there for why light mode needs the extra step.
              fontWeight: light ? 450 : 350,
              // A little breathing room between the model name and the
              // percentage (the flex `gap` alone reads cramped at this size).
              marginRight: 3,
            },
          },
          model,
        ),
        // Laptop → percentage + battery glyph. Everything else → device icon.
        isLaptop &&
          h(
            'span',
            {
              style: {
                // Dark-on-light text looks thinner than light-on-dark text at
                // the same weight: the light glyphs bloom outward on a dark
                // panel, while dark glyphs on white stay crisp and read thin.
                // So light mode needs *more* weight, not less — 450 against
                // dark mode's 350 lands both at the same perceived stroke.
                fontWeight: light ? 450 : 350,
                color,
                fontFamily: appleFont,
                fontVariantNumeric: 'tabular-nums',
                fontFeatureSettings: '"tnum" 1, "ss01" 1',
              },
            },
            percent === null ? '—' : `${percent}%`,
          ),
        isLaptop
          // Width 26 keeps a 1:1 mapping to the 26×18 viewBox, so the box is
          // exactly 26×18 — both integers. A fractional box height
          // (24 × 18/26 ≈ 16.6) rounds differently at DPR 1 and DPR 2, which
          // is why the glyph looked aligned on one screen and not the other.
          ? h(BatteryGlyph, { percent, mode, color, width: 26 })
          : h(DeviceIcon, { kind, color }),
      )
    }

    /** Move this slot's wrapper (normally above the row) back onto the row. */
    const STYLE_ID = 'dsh-device-badge-style'
    const CSS = `
:has(> [data-slot="${SLOT}"] > [data-device-badge]) {
  top: 0 !important;
  bottom: 0 !important;
  pointer-events: none !important;
  z-index: 2 !important;
}

/* Collapsed rail has no room for the text badge — hide it rather than let it
   overlap the avatar button. */
[class*="rail"] :has(> [data-slot="${SLOT}"] > [data-device-badge]),
[class*="collapsed"] :has(> [data-slot="${SLOT}"] > [data-device-badge]) {
  display: none !important;
}

/* Narrow screens (phones / the mobile gateway's web view). Below ~360px the
   account row cannot fit avatar + nickname + model + percentage + glyph, so the
   badge used to slide left and collide with the nickname. Hiding it there is
   the honest choice: the phone UI has its own status area anyway. */
@media (max-width: 380px) {
  :has(> [data-slot="${SLOT}"] > [data-device-badge]) {
    display: none !important;
  }
}
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const text = pickText(ctx)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            if (style.parentNode !== null) style.remove()
          }
        }, 'device-badge: row placement styles')

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'device-badge',
              order: 50,
            },
            (props) => h(DeviceBadge, { ...props, t: text }),
          ),
        )
      },
    }
  },
})
