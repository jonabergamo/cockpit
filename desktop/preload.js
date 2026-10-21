// Tells the page it runs inside the desktop app, so it can make room for the title bar, and gives it back and
// forward, which a window without browser buttons doesn't have.

const { contextBridge, ipcRenderer } = require('electron')

// the latest back/forward state, for a page that starts listening after the app sent it
let navState = { back: false, forward: false }
const navListeners = []
ipcRenderer.on('nav-state', (_, state) => {
  navState = state
  for (const fn of navListeners) fn(state)
})

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  setUrl: (url) => ipcRenderer.invoke('set-url', url),
  setColors: (colors) => ipcRenderer.send('set-colors', colors),
  notify: (n) => ipcRenderer.send('notify', n),
  onNavigate: (fn) => ipcRenderer.on('navigate', (_, link) => fn(link)),
  back: () => ipcRenderer.send('nav', 'back'),
  forward: () => ipcRenderer.send('nav', 'forward'),
  onNavState: (fn) => {
    navListeners.push(fn)
    fn(navState)
  },
})

// Back and forward from the keyboard and the mouse, but never while typing: ⌘[ indents in the editor and
// Alt+arrows move by word in a terminal.
const typing = (el) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, .xterm')

window.addEventListener(
  'keydown',
  (e) => {
    if (e.defaultPrevented || typing(e.target)) return
    const mac = process.platform === 'darwin'
    const back = mac ? e.metaKey && !e.altKey && !e.shiftKey && e.key === '[' : e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft'
    const forward = mac ? e.metaKey && !e.altKey && !e.shiftKey && e.key === ']' : e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight'
    if (!back && !forward) return
    e.preventDefault()
    ipcRenderer.send('nav', back ? 'back' : 'forward')
  },
  true,
)

// the back and forward buttons on a mouse, on every platform
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  ipcRenderer.send('nav', e.button === 3 ? 'back' : 'forward')
})

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = process.platform
})
