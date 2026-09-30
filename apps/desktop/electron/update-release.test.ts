/**
 * Tests for electron/update-release.ts — GitHub Releases update detection and
 * installer hand-off for packaged All-in-One ForX builds.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildMacInstallerHandoff,
  buildWindowsInstallerHandoff,
  DEFAULT_RELEASE_REPO_SLUG,
  isNewerReleaseVersion,
  latestReleaseApiUrl,
  normalizeSemver,
  parseReleaseNotesToCommits,
  parseReleaseUpdateCheck,
  selectReleaseAsset
} from './update-release'

test('normalizeSemver and isNewerReleaseVersion compare release tags accurately', () => {
  assert.deepEqual(normalizeSemver('v0.1.0'), [0, 1, 0])
  assert.deepEqual(normalizeSemver('1.2.3-beta.1'), [1, 2, 3])
  assert.equal(normalizeSemver('not-a-version'), null)

  assert.equal(isNewerReleaseVersion('0.1.0', 'v0.1.0'), false)
  assert.equal(isNewerReleaseVersion('0.1.0', 'v0.1.1'), true)
  assert.equal(isNewerReleaseVersion('0.1.0', 'v0.2.0'), true)
  assert.equal(isNewerReleaseVersion('0.2.0', 'v0.1.9'), false)
})

test('selectReleaseAsset picks the right installer for Windows and macOS while ignoring checksums', () => {
  const assets = [
    {
      name: 'SHA256SUMS.txt',
      browser_download_url: 'https://github.com/xtcamille/hermes-forX/releases/download/v0.2.0/SHA256SUMS.txt',
      size: 256
    },
    {
      name: 'ForX-0.2.0-win-x64.exe',
      browser_download_url: 'https://github.com/xtcamille/hermes-forX/releases/download/v0.2.0/ForX-0.2.0-win-x64.exe',
      size: 120_000_000
    },
    {
      name: 'ForX-0.2.0-mac-arm64.dmg',
      browser_download_url: 'https://github.com/xtcamille/hermes-forX/releases/download/v0.2.0/ForX-0.2.0-mac-arm64.dmg',
      size: 110_000_000
    },
    {
      name: 'ForX-0.2.0-mac-arm64.zip',
      browser_download_url: 'https://github.com/xtcamille/hermes-forX/releases/download/v0.2.0/ForX-0.2.0-mac-arm64.zip',
      size: 105_000_000
    }
  ]

  const winAsset = selectReleaseAsset(assets, 'win32', 'x64')
  assert.equal(winAsset?.name, 'ForX-0.2.0-win-x64.exe')
  assert.equal(winAsset?.size, 120_000_000)

  const macAsset = selectReleaseAsset(assets, 'darwin', 'arm64')
  assert.equal(macAsset?.name, 'ForX-0.2.0-mac-arm64.zip')
})

test('parseReleaseUpdateCheck maps GitHub release payload to DesktopUpdateStatus fields', () => {
  const payload = {
    tag_name: 'v0.2.0',
    name: 'ForX Desktop v0.2.0',
    html_url: 'https://github.com/xtcamille/hermes-forX/releases/tag/v0.2.0',
    published_at: '2026-09-30T10:00:00Z',
    author: { login: 'CamilleZxt' },
    body: "## What's Changed\n* feat(desktop): add release auto-update by @CamilleZxt in https://github.com/xtcamille/hermes-forX/pull/1\n* fix(auth): improve token refresh\n\n**Full Changelog**: https://github.com/xtcamille/hermes-forX/compare/v0.1.0...v0.2.0",
    assets: [
      {
        name: 'ForX-0.2.0-win-x64.exe',
        browser_download_url:
          'https://github.com/xtcamille/hermes-forX/releases/download/v0.2.0/ForX-0.2.0-win-x64.exe',
        size: 99_000_000
      }
    ]
  }

  const available = parseReleaseUpdateCheck(payload, {
    currentVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64'
  })

  assert.equal(available?.updateAvailable, true)
  assert.equal(available?.behind, 2)
  assert.equal(available?.targetSha, 'v0.2.0')
  assert.equal(available?.assetName, 'ForX-0.2.0-win-x64.exe')
  assert.deepEqual(
    available?.commits.map(c => c.summary),
    ['feat(desktop): add release auto-update', 'fix(auth): improve token refresh']
  )

  const current = parseReleaseUpdateCheck(payload, {
    currentVersion: '0.2.0',
    platform: 'win32',
    arch: 'x64'
  })

  assert.equal(current?.updateAvailable, false)
  assert.equal(current?.behind, 0)
  assert.deepEqual(current?.commits, [])
})

test('parseReleaseNotesToCommits falls back to release title when body is empty', () => {
  const commits = parseReleaseNotesToCommits({
    tag_name: 'v0.3.0',
    name: 'ForX Desktop v0.3.0',
    body: ''
  })

  assert.equal(commits.length, 1)
  assert.equal(commits[0].summary, 'feat: ForX Desktop v0.3.0')
  assert.equal(latestReleaseApiUrl(), `https://api.github.com/repos/${DEFAULT_RELEASE_REPO_SLUG}/releases/latest`)
})

test('buildWindowsInstallerHandoff and buildMacInstallerHandoff pass paths via env without shell-interpolating them', () => {
  const win = buildWindowsInstallerHandoff({
    installerPath: 'C:\\Users\\Test User\\AppData\\Local\\Temp\\ForX-0.2.0-win-x64.exe',
    installDir: 'C:\\Users\\Test User\\AppData\\Local\\Programs\\ForX',
    desktopPid: 4321,
    relaunchExe: 'C:\\Users\\Test User\\AppData\\Local\\Programs\\ForX\\ForX.exe'
  })

  assert.equal(win.command, 'cmd.exe')
  assert.equal(win.detached, false)
  assert.equal(win.env.FORX_UPDATE_DESKTOP_PID, '4321')
  assert.ok(win.args.includes('-EncodedCommand'))

  const mac = buildMacInstallerHandoff({
    archivePath: '/tmp/ForX-0.2.0-mac-arm64.zip',
    targetAppBundle: '/Applications/ForX.app',
    desktopPid: 8765
  })

  assert.equal(mac.command, '/bin/bash')
  assert.equal(mac.detached, true)
  assert.equal(mac.env.FORX_UPDATE_ARCHIVE, '/tmp/ForX-0.2.0-mac-arm64.zip')
  assert.equal(mac.env.FORX_UPDATE_TARGET_APP, '/Applications/ForX.app')
})
