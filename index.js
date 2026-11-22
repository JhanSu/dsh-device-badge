/**
 * dsh-device-badge — host half.
 *
 * Serves one read-only loopback route the sidebar badge polls:
 *   GET /api/device-badge/status
 *
 * Detects what kind of machine DSH is running on and returns enough for the
 * client to pick the right presentation:
 *
 *   laptop   → model + battery % + battery glyph (the whole point of the badge)
 *   desktop  → model + a device icon, no battery numbers
 *
 * Data sources (all system binaries, no privileges required):
 *   macOS   /usr/bin/pmset -g batt          → charge %, charging, time left
 *   macOS   /usr/sbin/sysctl -n hw.model    → hardware model identifier
 *   Linux   /etc/os-release + DMI           → NAS / server identification
 *   Windows PowerShell CIM queries          → model + battery presence
 *
 * Privacy: nothing leaves this machine. We read battery/AC state and a
 * non-unique model identifier only. We never read the serial number, hardware
 * UUID, provisioning UDID or any account data, and nothing is written to disk.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export const name = 'device-badge'

const STATUS_ROUTE = '/api/device-badge/status'
const CACHE_MS = 1_000
const COMMAND_TIMEOUT_MS = 4_000

/** Hardware identifier → marketing name. Extend freely; unknown ids fall back. */
const MODEL_NAMES = {
  // Apple Silicon — MacBook Air
  'MacBookAir10,1': 'MacBook Air (M1, 2020)',
  'Mac14,2': 'MacBook Air (M2, 2022)',
  'Mac14,15': 'MacBook Air (15-inch, M2, 2023)',
  'Mac15,12': 'MacBook Air (13-inch, M3, 2024)',
  'Mac15,13': 'MacBook Air (15-inch, M3, 2024)',
  'Mac16,12': 'MacBook Air (13-inch, M4, 2025)',
  'Mac16,13': 'MacBook Air (15-inch, M4, 2025)',
  // Apple Silicon — MacBook Pro
  'MacBookPro17,1': 'MacBook Pro (13-inch, M1, 2020)',
  'MacBookPro18,1': 'MacBook Pro (16-inch, M1 Pro, 2021)',
  'MacBookPro18,2': 'MacBook Pro (16-inch, M1 Max, 2021)',
  'MacBookPro18,3': 'MacBook Pro (14-inch, M1 Pro, 2021)',
  'MacBookPro18,4': 'MacBook Pro (14-inch, M1 Max, 2021)',
  'Mac13,1': 'Mac Studio (2022)',
  'Mac13,2': 'Mac Studio (2022)',
  'Mac14,13': 'Mac Studio (M2 Max, 2023)',
  'Mac14,14': 'Mac Studio (M2 Ultra, 2023)',
  // Desktop Macs
  'iMac21,1': 'iMac (24-inch, M1, 2021)',
  'iMac21,2': 'iMac (24-inch, M1, 2021)',
  'Mac15,4': 'iMac (24-inch, M3, 2023)',
  'Mac15,5': 'iMac (24-inch, M3, 2023)',
  'Macmini9,1': 'Mac mini (M1, 2020)',
  'Mac14,3': 'Mac mini (M2, 2023)',
  'Mac14,12': 'Mac mini (M2 Pro, 2023)',
  'Mac16,10': 'Mac mini (M4, 2024)',
  'Mac16,11': 'Mac mini (M4 Pro, 2024)',
  'MacPro7,1': 'Mac Pro (2019)',
  'Mac14,8': 'Mac Pro (2023)',
}

/** iMac / Mac mini / Mac Studio / Mac Pro — battery-free Apple desktops. */
const APPLE_DESKTOP_PREFIXES = ['iMac', 'Macmini', 'MacStudio', 'MacPro', 'MacPro']

/** Compact "MacBook Air M1" form for the narrow sidebar row. */
function shortModelLabel(modelId, label) {
  if (typeof label !== 'string' || label === '') return modelId ?? null
  const match = /^(MacBook(?: Air| Pro)|iMac|Mac mini|Mac Studio|Mac Pro)\s*(?:\(([^)]*)\))?$/.exec(
    label,
  )
  if (match === null) return label
  const base = match[1]
  const detail = match[2]
  if (detail === undefined) return base
  // "MacBook Air (M1, 2020)" → "MacBook Air M1"
  // "iMac (24-inch, M1, 2021)" → "iMac M1"
  const series = detail
    .split(',')
    .map((part) => part.trim())
    .find((part) => /^M\d/.test(part))
  return series === undefined ? base : `${base} ${series}`
}

/**
 * Even shorter than `shortModelLabel` — just the product family.
 *
 * Used as the middle rung of the client's three-step degradation: if the
 * full label would collide with a long account name, the badge falls back to
 * "MacBook", "iMac", "Mac mini", or the NAS brand name; if that still does not
 * fit, it drops the text entirely and shows only the glyph.
 */
function briefModelLabel(modelId, label, kind, nasBrand) {
  const NAS_NAMES = {
    synology: '群晖',
    zspace: '极空间',
    ugreen: '绿联',
    fnos: '飞牛',
  }
  if (kind === 'nas') return NAS_NAMES[nasBrand] ?? null
  if (typeof label === 'string') {
    // Family only — "MacBook Air M1" must degrade to "MacBook", not
    // "MacBook Air", otherwise it barely saves any width.
    const family = /^(MacBook|iMac|Mac mini|Mac Studio|Mac Pro)/.exec(label)
    if (family !== null) return family[1]
  }
  if (kind === 'desktop-windows') return 'Windows'
  return null
}

/** Which icon family to ask the client for. */
function deviceKindFor(modelId, platform, hasBattery) {
  if (platform === 'darwin') {
    if (typeof modelId === 'string') {
      if (APPLE_DESKTOP_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
        if (modelId.startsWith('iMac')) return 'imac'
        if (modelId.startsWith('Macmini')) return 'macmini'
        // Mac Studio / Mac Pro have no dedicated icon yet — reuse the mini box.
        return 'macmini'
      }
      if (modelId.startsWith('MacBook')) return 'laptop'
    }
    return hasBattery ? 'laptop' : 'macmini'
  }
  if (platform === 'win32') return hasBattery ? 'laptop' : 'desktop-windows'
  // Anything else that reports a battery is a laptop; otherwise treat it as a
  // NAS/server box. Brand detection happens in detectNasBrand().
  return hasBattery ? 'laptop' : 'nas'
}

/**
 * Identify which NAS brand this Linux host is, from DMI vendor strings.
 * Returns one of: synology | zspace | ugreen | fnos | null
 */
function detectNasBrand(vendor, product, osRelease) {
  const haystack = `${vendor} ${product} ${osRelease}`.toLowerCase()
  if (haystack.includes('synology')) return 'synology'
  if (haystack.includes('zspace') || haystack.includes('zidoo')) return 'zspace'
  if (haystack.includes('ugreen') || haystack.includes('绿联')) return 'ugreen'
  if (haystack.includes('fnos') || haystack.includes('feiniu') || haystack.includes('飞牛')) return 'fnos'
  return null
}

/**
 * Parse `pmset -g batt` output.
 *
 * Example line:
 *   -InternalBattery-0 (id=6619235)	61%; discharging; 1:35 remaining present: true
 *   -InternalBattery-0 (id=6619235)	100%; charged; 0:00 remaining present: true
 *   -InternalBattery-0 (id=6619235)	80%; AC attached; not charging present: true
 */
function parsePmset(text) {
  const line = String(text)
    .split('\n')
    .find((row) => /%/.test(row) && /(InternalBattery|Battery)/.test(row))
  if (line === undefined) return null

  const pct = /(\d+)%/.exec(line)
  if (pct === null) return null
  const percent = Number(pct[1])
  if (!Number.isFinite(percent)) return null

  const state = (line.split(';')[1] ?? '').trim().toLowerCase()
  // "discharging" contains the substring "charging", so it must be excluded
  // before testing for the charging keyword.
  const discharging = /discharging/.test(state)
  const notCharging = /not charging/.test(state)
  // pmset reports "finishing charge" for the last stretch at 100% while still
  // on power — macOS keeps the bolt on screen then, so treat it as charging.
  const finishing = /finishing charge/.test(state)
  const charging =
    !discharging && !notCharging && (/(^|\s)charging(\s|$)/.test(state) || finishing)
  // "charged" must not swallow "finishing charge"; match it as a word.
  const charged = /(^|\s)charged(\s|;|$)/.test(state) && !finishing
  const acAttached = charging || charged || /ac attached/.test(state)

  const remaining = /(\d+):(\d+)\s*remaining/.exec(line)
  const remainingMinutes =
    remaining === null ? null : Number(remaining[1]) * 60 + Number(remaining[2])

  return {
    percent,
    charging,
    charged,
    acAttached,
    remainingMinutes,
    rawState: state,
  }
}

let cache = { at: 0, value: null }

async function readMacModel() {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'hw.model'], {
      timeout: COMMAND_TIMEOUT_MS,
    })
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

/**
 * macOS marketing version and build, e.g. "macOS 15.7.4" + "24G517".
 *
 * `sw_vers` is the cheapest source (7 ms measured) and needs no privileges, so
 * it runs alongside the battery read rather than being a separate round trip.
 */
async function readMacOsVersion() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/sw_vers', [], {
      timeout: COMMAND_TIMEOUT_MS,
    })
    const lines = String(stdout)
    const pick = (key) => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(lines)
      return m === null ? null : m[1].trim()
    }
    return {
      name: pick('ProductName'),
      version: pick('ProductVersion'),
      build: pick('BuildVersion'),
    }
  } catch {
    return { name: null, version: null, build: null }
  }
}

async function readMacBattery() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'batt'], {
      timeout: COMMAND_TIMEOUT_MS,
    })
    return parsePmset(String(stdout))
  } catch {
    return null
  }
}

/** Read one DMI field on Linux; missing files are normal (containers, VMs). */
async function readDmi(file) {
  try {
    const text = await readFile(`/sys/class/dmi/id/${file}`, 'utf8')
    return text.trim() || null
  } catch {
    return null
  }
}

async function readOsRelease() {
  try {
    return await readFile('/etc/os-release', 'utf8')
  } catch {
    return ''
  }
}

/** Any /sys/class/power_supply entry of type Battery counts as a battery. */
async function readLinuxBattery() {
  try {
    const { stdout } = await execFileAsync('sh', [
      '-c',
      "for d in /sys/class/power_supply/*/; do [ -r \"$d/type\" ] && [ \"$(cat \"$d/type\")\" = Battery ] && echo \"$d\"; done",
    ], { timeout: COMMAND_TIMEOUT_MS })
    const dir = String(stdout).trim().split('\n').filter(Boolean)[0]
    if (dir === undefined) return null

    const read = async (name) => {
      try {
        return (await readFile(`${dir}${name}`, 'utf8')).trim()
      } catch {
        return null
      }
    }
    const capacity = Number(await read('capacity'))
    if (!Number.isFinite(capacity)) return null
    const status = (await read('status')) ?? ''
    const charging = status === 'Charging'
    const charged = status === 'Full'
    return {
      percent: capacity,
      charging,
      charged,
      acAttached: charging || charged || status === 'Not charging',
      remainingMinutes: null,
      rawState: status.toLowerCase() || 'unknown',
    }
  } catch {
    return null
  }
}

async function readWindowsInfo() {
  // Two layers of defence against Windows text encoding:
  //
  // 1. Every call runs a preamble that forces PowerShell's output encoding to
  //    UTF-8. PowerShell otherwise writes stdout in the *console* code page —
  //    936 (GBK) on a Simplified-Chinese Windows — while Node decodes stdout as
  //    UTF-8, so "Windows 11 专业版" arrives as mojibake.
  // 2. Anything carrying user-visible localised text goes through psJson(),
  //    which returns base64-encoded JSON. Base64 is pure ASCII, so no code page
  //    can touch it regardless of how PowerShell is configured.
  const UTF8_PREAMBLE =
    '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '

  const ps = (script) =>
    execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', UTF8_PREAMBLE + script],
      { timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' },
    ).then((r) => String(r.stdout).trim())

  /**
   * Run a PowerShell expression and return the decoded JSON it produces.
   *
   * The script is asked to emit `[Convert]::ToBase64String(...)` of the UTF-8
   * bytes rather than the text itself. Base64 is pure ASCII, so nothing can be
   * mangled by the console code page on the way out — this sidesteps the whole
   * class of Windows encoding bugs instead of fighting it with chcp.
   */
  const psJson = async (expression) => {
    const b64 = await ps(
      `$json = ${expression} | ConvertTo-Json -Compress -Depth 4; ` +
        `[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))`,
    )
    if (!b64) return null
    const text = Buffer.from(b64, 'base64').toString('utf8')
    return JSON.parse(text)
  }


  // What to call this PC.
  //
  // `Win32_ComputerSystem.Model` is useless on a self-built desktop: it holds
  // the *motherboard* string (e.g. "JGINYUE"), not a machine name — there is no
  // brand to report for a hand-assembled box. The computer name the owner chose
  // is far more identifying, so Windows always reports that as the label.
  //
  // Windows version is captured alongside it for the tooltip: "Windows 11 专业版
  // 24H2 (26100)" tells you which box you're on better than "Windows" does.
  let model = null
  let osName = null
  let osVersion = null
  let osBuild = null
  let battery = null
  try {
    // Computer names may be Chinese ("张伟的台式机") on a localized Windows, so
    // they travel through psJson too — a plain `ps` call would mangle them the
    // same way the edition name was mangled.
    const name = await psJson('$env:COMPUTERNAME')
    model = typeof name === 'string' ? name.trim() || null : null
  } catch {
    /* ignore */
  }
  try {
    // Caption is localised ("Microsoft Windows 11 专业版"), which is exactly the
    // string the console code page used to mangle — psJson carries it as
    // base64 so the Chinese edition name survives the trip.
    const parsed = await psJson(
      'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber',
    )
    if (parsed) {
      // ConvertTo-Json returns a single object for one row; be tolerant anyway.
      const row = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed
      const caption = String(row.Caption ?? '')
        .replace(/^Microsoft\s+/i, '')
        .trim()
      // Caption already carries the edition, so osName is the whole readable
      // name and osVersion stays empty — the build goes in osBuild, which the
      // client wraps in parentheses.
      osName = caption || null
      osVersion = null
      osBuild =
        String(row.BuildNumber ?? '').trim() ||
        String(row.Version ?? '').trim() ||
        null
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = await ps(
      'Get-CimInstance Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining',
    )
    const percent = Number(raw)
    if (Number.isFinite(percent) && raw !== '') {
      const status = Number(
        await ps(
          'Get-CimInstance Win32_Battery | Select-Object -First 1 -ExpandProperty BatteryStatus',
        ),
      )
      // Win32_Battery BatteryStatus: 2 = on AC, 1 = discharging, 6/7/8/9 = charging
      const charging = [6, 7, 8, 9].includes(status)
      battery = {
        percent,
        charging,
        charged: status === 2 && percent >= 99,
        acAttached: status === 2 || charging,
        remainingMinutes: null,
        rawState: charging ? 'charging' : status === 2 ? 'ac' : 'discharging',
      }
    }
  } catch {
    /* no battery */
  }
  return { model, osName, osVersion, osBuild, battery }
}

async function snapshot({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && cache.value !== null && now - cache.at < CACHE_MS) return cache.value

  const platform = process.platform
  let modelId = null
  let modelLabel = null
  let battery = null
  let brand = null
  let osName = null
  let osVersion = null
  let osBuild = null

  if (platform === 'darwin') {
    const [id, batt, os] = await Promise.all([
      readMacModel(),
      readMacBattery(),
      readMacOsVersion(),
    ])
    modelId = id
    battery = batt
    modelLabel = id === null ? null : MODEL_NAMES[id] ?? null
    osName = os.name
    osVersion = os.version
    osBuild = os.build
  } else if (platform === 'win32') {
    const info = await readWindowsInfo()
    modelLabel = info.model
    modelId = info.model
    osName = info.osName
    osVersion = info.osVersion
    osBuild = info.osBuild
    battery = info.battery
  } else {
    const [vendor, product, osRelease, batt] = await Promise.all([
      readDmi('board_vendor'),
      readDmi('board_name'),
      readOsRelease(),
      readLinuxBattery(),
    ])
    battery = batt
    brand = detectNasBrand(vendor, product, osRelease)
    modelLabel = product ?? vendor ?? null
    modelId = modelLabel
    // /etc/os-release gives PRETTY_NAME ("Ubuntu 24.04.1 LTS") and
    // VERSION_ID for the tooltip, same fields the other platforms fill.
    const osVars = Object.fromEntries(
      String(osRelease)
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2)
        .map(([k, v]) => [k.trim(), v.trim().replace(/^"|"$/g, '')]),
    )
    osName = osVars.PRETTY_NAME ?? osVars.NAME ?? null
    osVersion = osVars.VERSION_ID ?? null
    osBuild = osVars.BUILD_ID ?? null
  }

  const kind = deviceKindFor(modelId, platform, battery !== null)
  const hostname =
    platform === 'darwin' || platform === 'win32'
      ? null
      : (await readDmi('product_name')) ?? null

  const value = {
    ok: true,
    platform,
    kind, // 'laptop' | 'imac' | 'macmini' | 'desktop-windows' | 'nas'
    nasBrand: kind === 'nas' ? brand : null,
    hasBattery: battery !== null,
    modelId,
    modelLabel,
    modelShort: shortModelLabel(modelId, modelLabel),
    modelBrief: briefModelLabel(modelId, modelLabel, kind, brand),
    // OS name + version/build, shown in the tooltip. Set on every platform.
    osName,
    osVersion,
    osBuild,
    hostname,
    ...(battery === null
      ? {}
      : {
          percent: battery.percent,
          charging: battery.charging,
          charged: battery.charged,
          acAttached: battery.acAttached,
          remainingMinutes: battery.remainingMinutes,
          state: battery.rawState,
        }),
    sampledAt: now,
  }
  cache = { at: now, value }
  return value
}

export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const server = ctx.webServer
  if (server === undefined || typeof server.register !== 'function') return

  // The browser cookie is the same signed dsh-auth-* session the rest of the UI
  // uses. `connection.requestRejection` is the host's own fence: it returns 403
  // for a foreign Host/Origin and 401 when that cookie is missing or invalid.
  // Without it this route would hand device data to any local process.
  const connection = ctx.connection
  const authRejection = (req) => {
    try {
      return typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 401
    } catch {
      return 401
    }
  }

  const isLoopbackRequest = (req) => {
    const address = req.socket?.remoteAddress ?? ''
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1' ||
      address.startsWith('127.')
    )
  }

  const sendJson = (res, status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  ctx.effect(
    () => server.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const rejection = authRejection(req)
        if (rejection !== undefined && rejection !== null) {
          sendJson(res, res.statusCode ?? 401, { ok: false, error: 'unauthorized' })
          return
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        const fresh = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('fresh') === '1'
        snapshot({ fresh })
          .then((value) => sendJson(res, 200, value))
          .then(() => undefined)
          .catch(() => sendJson(res, 500, { ok: false, error: 'internal error' }))
      },
    }),
    'device-badge: status route',
  )
}

export { parsePmset, MODEL_NAMES }
