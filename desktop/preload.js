// Tells the page it runs inside the desktop app, so it can make room for the title bar.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  setUrl: (url) => ipcRenderer.invoke('set-url', url),
  setColors: (colors) => ipcRenderer.send('set-colors', colors),
  notify: (n) => ipcRenderer.send('notify', n),
  onNavigate: (fn) => ipcRenderer.on('navigate', (_, link) => fn(link)),
})

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktop = process.platform
})
