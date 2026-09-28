'use strict'
/**
 * macOS notifications via Electron. Clicking one brings the window forward
 * and opens the item it is about.
 */
function createNotifier({ Notification, onClick = () => {}, log = () => {} }) {
  return {
    show({ title, body, itemId = null }) {
      try {
        if (!Notification.isSupported()) return
        const n = new Notification({ title, body, silent: false })
        n.on('click', () => onClick(itemId))
        n.show()
      } catch (e) { log('notification failed', e) }
    },
  }
}

module.exports = { createNotifier }
