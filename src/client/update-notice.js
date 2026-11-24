/**
 * Update reminder surfaces for the Mojie provider.
 *
 * The toast is registered in the frame-wide `shell.overlay` slot, the seat
 * DSH's own release prompt and plugin-manager refresh toast use, so it sits
 * above the app without touching another plugin's DOM. The Models card adds a
 * quieter line for users who open settings after dismissing the toast.
 *
 * @module @mojieai/dsh-mojie-model-provider/client/update-notice
 */

import { createElement as h, Fragment, useEffect, useState } from 'react'
import {
  Dialog,
  IconButton,
  LinkButton,
  PrimaryButton,
  SecondaryButton,
  cls,
} from './native-ui.js'
import { PACKAGE_NAME, PACKAGE_PAGE } from './update-check.js'

/**
 * Follow one update store without pulling in the shell's store primitives.
 * @param {object | undefined} update - the reminder store, when the plugin has one.
 * @returns {object | undefined} the current snapshot.
 */
export function useUpdateSnapshot(update) {
  const [snapshot, setSnapshot] = useState(() => update?.getSnapshot())
  useEffect(() => {
    if (update === undefined) return undefined
    setSnapshot(update.getSnapshot())
    return update.subscribe(() => { setSnapshot(update.getSnapshot()) })
  }, [update])
  return snapshot
}

/**
 * Open the installed bundle's page on the Plugins panel, when the current peer
 * may use it.
 * @param {object | undefined} ctx - the browser plugin context.
 * @returns {boolean} whether a page was opened.
 */
export function openPluginPage(ctx) {
  const navigation = ctx?.get?.('pluginNavigation')
  if (navigation === undefined || typeof navigation.openBundle !== 'function') return false
  navigation.openBundle(PACKAGE_NAME)
  return true
}

/**
 * The line the Models card shows while a newer release exists.
 * @param {object} props - `update` store.
 * @returns {object | null} the hint, or null when nothing is newer.
 */
export function MojieUpdateHint({ update }) {
  const snapshot = useUpdateSnapshot(update)
  if (snapshot?.available !== true) return null
  return h('div', { className: cls.updateHint, role: 'status' }, [
    h('span', { key: 'tag', className: cls.tag }, '可更新'),
    h('span', { key: 'text' }, `已发布 v${snapshot.latest}（当前 v${snapshot.current}），可在左侧「插件」页面更新。`),
  ])
}

/**
 * Fallback instructions used when the Plugins panel cannot be opened from here,
 * for example on a remote peer without plugin-management access.
 * @param {object} props - target version, dialog open state, and close callback.
 * @returns {object | null} the dialog, or null while closed.
 */
function UpdateInstructions({ latest, current, open, onClose }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])
  const command = `dsh plugin --profile desktop add ${PACKAGE_NAME}@${latest}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      // A denied clipboard leaves the command selectable in the dialog.
      setCopied(false)
    }
  }
  return h(Dialog, {
    open,
    title: '更新 Mojie 插件',
    description: `当前 v${current}，最新 v${latest}。更新后请重启 DSH。`,
    onClose,
    footer: [
      h(SecondaryButton, { key: 'copy', onClick: () => { void copy() } }, copied ? '已复制命令' : '复制命令'),
      h(SecondaryButton, {
        key: 'page',
        onClick: () => {
          if (typeof window !== 'undefined') window.open(PACKAGE_PAGE, '_blank', 'noopener')
        },
      }, '打开 npm 页面'),
      h(PrimaryButton, { key: 'done', onClick: onClose }, '知道了'),
    ],
  }, [
    h('ol', { key: 'steps', className: cls.updateSteps }, [
      h('li', { key: 'plugins' }, '在左侧「插件」页面找到 Mojie 插件，点卡片上的「更新」。若没有「更新」按钮，可能是新版本要求更高的 DSH 版本。'),
      h('li', { key: 'command' }, [
        '也可以在终端重装（tarball 安装同样适用）：',
        h('code', { key: 'code', className: cls.updateCommand }, command),
      ]),
    ]),
  ])
}

/**
 * The frame-wide reminder toast and its fallback dialog.
 * @param {object} props - injected `update` store and browser plugin `ctx`.
 * @returns {object | null} the toast while a newer release is unacknowledged.
 */
export function MojieUpdateToast({ update, ctx }) {
  const snapshot = useUpdateSnapshot(update)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const latest = snapshot?.latest
  // A release published while this page is open is a new reminder, even after
  // the previous one was hidden by opening the Plugins page.
  useEffect(() => { setHidden(false) }, [latest])
  if (snapshot === undefined) return null
  const available = snapshot.available === true && snapshot.dismissed !== latest && latest !== undefined && !hidden
  if (!available && !instructionsOpen) return null
  const goUpdate = () => {
    if (!openPluginPage(ctx)) {
      setInstructionsOpen(true)
      return
    }
    // Navigating is not an acknowledgement: hide it for this page only, so a
    // user who did not finish updating is reminded again next launch.
    setHidden(true)
  }
  return h(Fragment, null, [
    available ? h('aside', {
      key: 'toast',
      className: cls.updateToast,
      role: 'status',
      'aria-live': 'polite',
    }, [
      h('div', { key: 'head', className: cls.updateToastHead }, [
        h('span', { key: 'title', className: cls.updateToastTitle }, 'Mojie 插件有新版本'),
        h(IconButton, {
          key: 'close',
          'aria-label': '不再提醒此版本',
          title: '不再提醒',
          onClick: () => update.dismiss(),
        }, '×'),
      ]),
      h('p', { key: 'body', className: cls.updateToastText }, [
        h('span', { key: 'latest', className: cls.mono }, `v${latest}`),
        ` 已发布（当前 v${snapshot.current}）。`,
      ]),
      h('div', { key: 'actions', className: cls.updateToastActions }, [
        h(LinkButton, { key: 'later', onClick: () => update.dismiss() }, '不再提醒'),
        h(PrimaryButton, { key: 'open', onClick: goUpdate }, '查看更新'),
      ]),
    ]) : null,
    latest === undefined ? null : h(UpdateInstructions, {
      key: 'instructions',
      latest,
      current: snapshot.current,
      open: instructionsOpen,
      onClose: () => { setInstructionsOpen(false) },
    }),
  ])
}
