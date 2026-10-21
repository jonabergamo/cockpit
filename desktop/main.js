// cockpit as an app of its own. The server keeps running on the dev box, where Claude, the worktrees
// and the CLIs live; this is the window onto it, with the live session count in the menu bar and the dock.

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, shell } = require('electron')
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
  const busy = live.filter((s) => s.status === 'busy')
  const waiting = live.filter((s) => s.status === 'waiting')
  if (process.platform === 'darwin') {
    tray.setTitle(busy.length || waiting.length ? ` ${busy.length} · ${waiting.length}` : '')
    app.dock.setBadge(waiting.length ? String(waiting.length) : '')
  }
  tray.setToolTip(`cockpit: ${busy.length} working, ${waiting.length} waiting`)
  tray.setContextMenu(trayMenu(busy, waiting))
}

function trayMenu(busy = [], waiting = []) {
  // like the strip at the top of the page, a session opens straight in its terminal
  const item = (s) => ({ label: label(s).slice(0, 60), click: () => show(`/terminals?resume=${s.id}${s.pid ? `&pid=${s.pid}` : ''}`) })
  return Menu.buildFromTemplate([
    { label: 'Open cockpit', accelerator: 'CommandOrControl+Shift+K', click: () => show() },
    { type: 'separator' },
    ...(waiting.length ? [{ label: 'Waiting for you', enabled: false }, ...waiting.map(item), { type: 'separator' }] : []),
    ...(busy.length ? [{ label: 'Working', enabled: false }, ...busy.map(item), { type: 'separator' }] : []),
    { label: 'Today', click: () => show('/') },
    { label: 'Tickets', click: () => show('/tickets') },
    { label: 'Sprint report', click: () => show('/report') },
    { type: 'separator' },
    { label: 'Change server…', click: () => (base = null, show(), win.loadURL(setupPage(false))) },
    { label: 'Quit cockpit', accelerator: 'CommandOrControl+Q', click: quit },
  ])
}

let quitting = false
function quit() {
  quitting = true
  app.exit(0)
}

// native notifications for the page; a click brings the window up on the right screen
ipcMain.on('notify', (_, { title, body, link }) => {
  if (!Notification.isSupported() || typeof title !== 'string') return
  const n = new Notification({ title, body: String(body ?? ''), silent: false })
  n.on('click', () => {
    show()
    if (typeof link === 'string' && link.startsWith('/')) win?.webContents.send('navigate', link)
  })
  n.show()
})

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
  app.on('second-instance', () => show())
  app.on('activate', () => show())
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => (quitting = true))

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock.setIcon(icon(512))
    tray = new Tray(trayIcon())
    tray.setToolTip('cockpit')
    tray.setContextMenu(trayMenu())
    globalShortcut.register('CommandOrControl+Shift+K', () => (win?.isFocused() ? win.hide() : show()))

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
  })
}
