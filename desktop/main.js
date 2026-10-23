// cockpit as an app of its own. The server keeps running on the dev box, where Claude, the worktrees
// and the CLIs live; this is the window onto it, with the live session count in the menu bar and the dock.

const { app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, globalShortcut, ipcMain, nativeImage, session, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'cockpit')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cockpit')
const SETTINGS = path.join(HOME, 'desktop.json')

app.setPath('userData', path.join(HOME, 'window'))
app.setName('cockpit')
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')

function settings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
  } catch {
    return {}
  }
}

function save(next) {
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), ...next }, null, 2))
}

async function answers(url) {
  try {
    const res = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

// COCKPIT_URL wins, then what the installer saved, then a server on this same machine
async function findServer() {
  const tries = [process.env.COCKPIT_URL, settings().url, 'http://127.0.0.1:8770'].filter(Boolean)
  for (const url of tries) if (await answers(url)) return url.replace(/\/$/, '')
}

const BG = '#151a22'
const FRAME = {
  backgroundColor: BG,
  autoHideMenuBar: true,
  webPreferences: { preload: path.join(__dirname, 'preload.js') },
  ...(process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: BG, symbolColor: '#8c96a6', height: 40 } }),
}

const page = (html) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag;
  background:${BG};color:#dce2ea;font:15px system-ui,sans-serif;text-align:center;padding:0 2rem"><div style="-webkit-app-region:no-drag;max-width:460px">${html}</div></body></html>`)

const setupPage = (tried) =>
  page(`<h2 style="font-weight:600">Where is cockpit running?</h2>
  <p style="color:#8c96a6">${tried ? "I couldn't reach the server. " : ''}Paste its address, like https://your-server.example.com:8444</p>
  <form onsubmit="event.preventDefault();window.desktop.setUrl(this.u.value)">
  <input name="u" autofocus value="${settings().url ?? ''}" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c3441;background:#1c222c;color:#dce2ea;font:inherit">
  <button style="margin-top:12px;padding:9px 16px;border-radius:8px;border:0;background:#6f93f5;color:white;font:600 14px system-ui">Connect</button></form>`)

let win = null
let tray = null
let base = null
let live = []

// the menu bar wants a black template image that macOS tints for light and dark bars
function trayIcon() {
  if (process.platform !== 'darwin') return icon(16)
  const img = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'))
  img.setTemplateImage(true)
  return img
}

function icon(size) {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: size, height: size })
}

async function show(route = '') {
  if (!win) {
    win = new BrowserWindow({ width: 1440, height: 900, minWidth: 420, minHeight: 500, title: 'cockpit', icon: icon(256), ...FRAME })
    win.on('close', (e) => {
      if (quitting) return
      // closing keeps it in the menu bar, so the session count stays up to date
      e.preventDefault()
      win.hide()
      if (process.platform === 'darwin') app.dock.hide()
    })
    win.on('closed', () => (win = null))
    // three-finger swipe on a Mac trackpad, like a browser
    win.on('swipe', (_, dir) => go(dir === 'right' ? 'back' : dir === 'left' ? 'forward' : ''))
    win.webContents.on('did-navigate', navState)
    win.webContents.on('did-navigate-in-page', navState)
    win.webContents.on('dom-ready', navState)
    win.loadURL(page('Connecting to cockpit…'))
  }
  if (process.platform === 'darwin') app.dock.show()
  win.show()
  win.focus()

  if (!base) base = await findServer()
  if (!base) return win.loadURL(setupPage(true))
  const target = base + route
  if (route || !win.webContents.getURL().startsWith(base)) win.loadURL(target)
  watch()
  autoConfig()
}

async function openWindow(route) {
  if (!base) base = await findServer()
  if (!base) return show()
  if (process.platform === 'darwin') app.dock.show()
  const w = new BrowserWindow({ width: 1200, height: 900, minWidth: 420, minHeight: 500, title: 'cockpit', icon: icon(256), ...FRAME })
  w.loadURL(base + route)
}

// --- live session count, from the same socket the page uses ----------------

let socket = null

function watch() {
  if (socket || !base) return
  socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
  socket.onmessage = (m) => {
    const ev = JSON.parse(m.data)
    if (ev.type !== 'sessions') return
    live = ev.sessions
    refresh()
  }
  socket.onclose = () => {
    socket = null
    setTimeout(watch, 3000)
  }
  socket.onerror = () => socket?.close()
}

const label = (s) => s.title || s.name || path.basename(s.cwd)

function refresh() {
  if (!tray) return
  const busy = live.filter((s) => s.status === 'busy')
  const waiting = live.filter((s) => s.status === 'waiting')
  // the icon counts only sessions working or waiting for you; ones that finished their turn don't count
  const active = busy.length + waiting.length
  if (process.platform === 'darwin') {
    tray.setTitle(active ? ` ${busy.length} · ${waiting.length}` : '')
    app.dock.setBadge(active ? String(active) : '')
  } else app.setBadgeCount(active)
  tray.setToolTip(`cockpit: ${busy.length} working, ${waiting.length} waiting`)
  tray.setContextMenu(trayMenu(busy, waiting))
}

function trayMenu(busy = [], waiting = []) {
  // like the strip at the top of the page, a session opens straight in its terminal
  const item = (s) => ({ label: label(s).slice(0, 60), click: () => show(`/terminals?resume=${s.id}${s.pid ? `&pid=${s.pid}` : ''}`) })
  const recording = meeting
    ? [
        { label: `Recording ${meeting.app ? `the ${meeting.app} meeting` : 'a meeting'}`, enabled: false },
        { label: 'Stop and write it up', click: () => stopMeeting() },
        { label: 'Show it', click: () => open(`/p/meetings/meetings${meeting.id ? `?id=${meeting.id}` : ''}`) },
      ]
    : auto.mode !== 'unavailable'
      ? [{ label: 'Record a meeting', click: () => startMeeting('', false) }]
      : []
  return Menu.buildFromTemplate([
    { label: 'Open cockpit', accelerator: 'CommandOrControl+Shift+K', click: () => show() },
    { type: 'separator' },
    ...(recording.length ? [...recording, { type: 'separator' }] : []),
    ...(waiting.length ? [{ label: 'Waiting for you', enabled: false }, ...waiting.map(item), { type: 'separator' }] : []),
    ...(busy.length ? [{ label: 'Working', enabled: false }, ...busy.map(item), { type: 'separator' }] : []),
    { label: 'Today', click: () => open('/') },
    { label: 'Board', click: () => open('/board') },
    { label: 'Tickets', click: () => open('/tickets') },
    { label: 'Sprint report', click: () => open('/report') },
    { type: 'separator' },
    { label: 'Change server…', click: () => (base = null, show(), win.loadURL(setupPage(false))) },
    { label: 'Quit cockpit', accelerator: 'CommandOrControl+Q', click: quit },
  ])
}

// --- navigation -------------------------------------------------------------

// back and forward go through the page's own history, so the router keeps working as it does in a browser
function go(dir) {
  const h = win?.webContents.navigationHistory
  if (!h) return
  if (dir === 'back' && h.canGoBack()) h.goBack()
  if (dir === 'forward' && h.canGoForward()) h.goForward()
}

// a page inside the app, without reloading it when it's already open
function open(route) {
  if (win && base && win.webContents.getURL().startsWith(base)) {
    show()
    win.webContents.send('navigate', route)
  } else show(route)
}

function navState() {
  const h = win?.webContents.navigationHistory
  if (h) win.webContents.send('nav-state', { back: h.canGoBack(), forward: h.canGoForward() })
}

const PAGES = [
  ['Today', '/'],
  ['Board', '/board'],
  ['Sessions', '/sessions'],
  ['Tickets', '/tickets'],
  ['Terminals', '/terminals'],
  ['Code', '/code'],
  ['Tasks', '/tasks'],
  ['Usage', '/usage'],
]

// Back and Forward only show their shortcuts here: the page handles them, so ⌘[ still indents in the editor
// and Alt+arrows still move by word in a terminal.
function appMenu() {
  const mac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: mac ? 'Cmd+[' : 'Alt+Left', registerAccelerator: false, click: () => go('back') },
        { label: 'Forward', accelerator: mac ? 'Cmd+]' : 'Alt+Right', registerAccelerator: false, click: () => go('forward') },
        { type: 'separator' },
        ...PAGES.map(([label, route], i) => ({ label, accelerator: `CommandOrControl+${i + 1}`, click: () => open(route) })),
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => open('/settings') },
      ],
    },
    { role: 'windowMenu' },
  ])
}

ipcMain.on('nav', (_, dir) => (dir === 'back' || dir === 'forward') && go(dir))

let quitting = false
function quit() {
  quitting = true
  micProc?.kill()
  app.exit(0)
}

// a native notification; a click brings the window up on the right page
function note(title, body, link, onClick) {
  if (!Notification.isSupported() || typeof title !== 'string') return
  const n = new Notification({ title, body: String(body ?? ''), silent: false })
  n.on('click', () => {
    if (onClick) return onClick()
    show()
    if (typeof link === 'string' && link.startsWith('/')) win?.webContents.send('navigate', link)
  })
  n.show()
}
ipcMain.on('notify', (_, { title, body, link }) => note(title, body, link))

// --- meetings: notice a meeting app using the mic, and record it ---------------------
//
// The Meetings plugin says whether to, and which apps are meeting apps. On a Mac a small Swift helper reports the
// apps using a microphone (it's compiled once, with the Xcode command line tools); on Linux PulseAudio or PipeWire
// does. The recording runs in a hidden window, so it goes on whatever the main window is showing.

const MICWATCH = path.join(HOME, 'micwatch')
let auto = { mode: 'unavailable', apps: [] }
let meeting = null
let micProc = null
// apps already offered while they hold the mic, so one call means one question
const offered = new Set()

async function autoConfig() {
  if (!base) return
  try {
    const res = await fetch(`${base}/api/plugins/meetings/x/auto`, { signal: AbortSignal.timeout(4000) })
    auto = res.ok ? await res.json() : { mode: 'unavailable', apps: [] }
  } catch {
    auto = { mode: 'unavailable', apps: [] }
  }
  refresh()
}

function micWatch(onChange) {
  if (process.platform === 'darwin') {
    const src = path.join(__dirname, 'micwatch.swift')
    const run = () => {
      micProc = spawn(MICWATCH, [], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      micProc.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try {
            onChange(JSON.parse(line).map((x) => ({ pid: x.pid, id: String(x.bundle).toLowerCase() })))
          } catch {}
        }
      })
      micProc.on('exit', () => !quitting && setTimeout(run, 10_000))
    }
    const fresh = fs.existsSync(MICWATCH) && (!fs.existsSync(src) || fs.statSync(MICWATCH).mtimeMs >= fs.statSync(src).mtimeMs)
    if (fresh) return run()
    if (!fs.existsSync(src)) return
    fs.mkdirSync(HOME, { recursive: true })
    execFile('xcrun', ['swiftc', '-O', src, '-o', MICWATCH], (err) => (err ? console.log("can't build micwatch, so meetings won't be noticed:", err.message) : run()))
  } else if (process.platform === 'linux') {
    setInterval(
      () =>
        execFile('pactl', ['-f', 'json', 'list', 'source-outputs'], (err, out) => {
          if (err) return
          try {
            const p = (o) => o.properties ?? {}
            onChange(JSON.parse(out).map((o) => ({ pid: Number(p(o)['application.process.id']), id: `${p(o)['application.process.binary'] ?? ''} ${p(o)['application.name'] ?? ''}`.toLowerCase() })))
          } catch {}
        }),
      3000,
    )
  }
}

function onMic(list) {
  const ours = new Set(app.getAppMetrics().map((m) => m.pid))
  const using = new Set()
  for (const p of list) {
    if (ours.has(p.pid)) continue
    const known = auto.apps.find((a) => p.id.includes(a.match))
    if (known) using.add(known.name)
  }
  for (const name of offered) if (!using.has(name)) offered.delete(name)
  if (meeting) {
    if (!meeting.auto) return
    // the call is over once its app has let go of the mic for half a minute
    if (using.has(meeting.app)) clearTimeout(meeting.stopTimer), (meeting.stopTimer = null)
    else if (!meeting.stopTimer) meeting.stopTimer = setTimeout(() => stopMeeting(), 30_000)
    return
  }
  const name = [...using].find((n) => !offered.has(n))
  if (!name || auto.mode === 'off' || auto.mode === 'unavailable') return
  offered.add(name)
  busyElsewhere().then((busy) => {
    if (busy || meeting) return
    if (auto.mode === 'record') return startMeeting(name, true)
    note(`${name} is using your mic`, 'Click to record this meeting. Claude writes it up when it ends.', null, () => startMeeting(name, true))
  })
}

// a recording already going on another page or device
async function busyElsewhere() {
  try {
    const res = await fetch(`${base}/api/plugins/meetings/x/meetings`, { signal: AbortSignal.timeout(4000) })
    return (await res.json()).meetings.some((m) => m.status === 'recording')
  } catch {
    return true
  }
}

async function startMeeting(name, byItself) {
  if (meeting || !base) return
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } })
  meeting = { app: name, auto: byItself, win: w, stopTimer: null, id: null }
  refresh()
  try {
    await w.loadURL(`${base}/plugins/meetings/assets/index.html`)
    for (let i = 0; i < 40 && !(await w.webContents.executeJavaScript('!!window.meetingsAuto')); i++) await new Promise((ok) => setTimeout(ok, 250))
    // as a user gesture, which sharing the computer's sound needs
    meeting.id = await w.webContents.executeJavaScript(`meetingsAuto.start(${JSON.stringify({ app: name || undefined })})`, true)
    note(name ? `Recording the ${name} meeting` : 'Recording a meeting', byItself ? 'It stops by itself when the call ends, and Claude writes it up.' : 'Stop it from the menu bar or the Meetings page.', `/p/meetings/meetings?id=${meeting.id}`)
    refresh()
    // stopped from the page: the hidden recorder has nothing left to do
    meeting.check = setInterval(async () => {
      const m = meeting
      if (m?.win !== w) return
      const still = await w.webContents.executeJavaScript('meetingsAuto.recording()').catch(() => null)
      if (still) return
      clearInterval(m.check)
      clearTimeout(m.stopTimer)
      w.destroy()
      meeting = null
      refresh()
    }, 10_000)
  } catch (e) {
    if (!w.isDestroyed()) w.destroy()
    meeting = null
    refresh()
    note(`Couldn't record ${name ? `the ${name} meeting` : 'the meeting'}`, String(e?.message ?? e), '/p/meetings/meetings')
  }
}

async function stopMeeting() {
  const m = meeting
  if (!m) return
  meeting = null
  clearTimeout(m.stopTimer)
  clearInterval(m.check)
  try {
    await m.win.webContents.executeJavaScript('meetingsAuto.stop()', true)
  } catch {}
  if (!m.win.isDestroyed()) m.win.destroy()
  refresh()
  note(m.app ? `The ${m.app} meeting ended` : 'The meeting ended', 'Claude is writing it up.', `/p/meetings/meetings${m.id ? `?id=${m.id}` : ''}`)
}

// the page tells us its theme so the window background and the Linux/Windows title bar match it
ipcMain.on('set-colors', (_, { background, foreground }) => {
  if (!win || win.isDestroyed() || !/^#[0-9a-f]{6}$/i.test(background) || !/^#[0-9a-f]{6}$/i.test(foreground)) return
  win.setBackgroundColor(background)
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: background, symbolColor: foreground, height: 40 })
})

ipcMain.handle('set-url', async (_, url) => {
  if (typeof url !== 'string' || !(await answers(url))) return win?.loadURL(setupPage(true))
  save({ url: url.replace(/\/$/, '') })
  base = url.replace(/\/$/, '')
  socket?.close()
  show('/')
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // launching it again with --open=<path> opens that page in a window of its own, next to the main one:
  // open -n -a cockpit --args --open=/runs
  app.on('second-instance', (_, argv) => {
    const route = argv.find((a) => a.startsWith('--open='))?.slice('--open='.length)
    if (route?.startsWith('/')) openWindow(route)
    else show()
  })
  app.on('activate', () => show())
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => (quitting = true))

  // the computer's own sound for screen sharing on macOS, through Core Audio taps
  if (process.platform === 'darwin') app.commandLine.appendSwitch('enable-features', 'MacCatapLoopbackAudioForScreenShare,MacLoopbackAudioForScreenShare')

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock.setIcon(icon(512))
    Menu.setApplicationMenu(appMenu())
    tray = new Tray(trayIcon())
    tray.setToolTip('cockpit')
    tray.setContextMenu(trayMenu())
    globalShortcut.register('CommandOrControl+Shift+K', () => (win?.isFocused() ? win.hide() : show()))

    // The server's pages may use the microphone, and a page that asks to share the screen gets the computer's sound
    // with it and no picker. That's how a page records both sides of a call taken in another app.
    const ours = (url) => !!base && typeof url === 'string' && url.startsWith(base)
    session.defaultSession.setPermissionRequestHandler((_, permission, done, details) => done(permission !== 'media' || ours(details.requestingUrl)))
    session.defaultSession.setPermissionCheckHandler((_, permission, origin) => permission !== 'media' || ours(origin))
    session.defaultSession.setDisplayMediaRequestHandler((request, done) => {
      if (!ours(request.securityOrigin)) return done({})
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then(([screen]) => done(screen ? { video: screen, audio: 'loopback' } : {}))
        .catch(() => done({}))
    })

    app.on('web-contents-created', (_, contents) => {
      // links to Jira, GitHub and the like open in the real browser
      contents.setWindowOpenHandler(({ url }) => {
        if (base && url.startsWith(base)) return { action: 'allow', overrideBrowserWindowOptions: { icon: icon(256), ...FRAME } }
        shell.openExternal(url)
        return { action: 'deny' }
      })
      contents.on('will-navigate', (e, url) => {
        if (url.startsWith('data:') || (base && url.startsWith(base))) return
        e.preventDefault()
        shell.openExternal(url)
      })
    })
    show()
    micWatch(onMic)
    setInterval(autoConfig, 5 * 60_000)
  })
}
