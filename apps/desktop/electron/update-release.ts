/**
 * GitHub Releases update checker and installer hand-off for packaged ForX builds.
 *
 * Packaged All-in-One builds (Windows NSIS .exe, macOS .dmg/.zip) bundle the
 * embedded Python runtime under `resources/backend` without a `.git` checkout.
 * When no git checkout governs the running app, `checkUpdates` queries the
 * official repo's latest GitHub Release and `applyUpdates` downloads the
 * matching platform asset, shuts down the local backend, and hands off to the
 * installer before exiting.
 */

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import type { CompareCommit } from './update-api-check'
import { githubRepoSlug } from './update-api-check'
import { updateCheckAgent } from './update-api-proxy'
import { OFFICIAL_REPO_HTTPS_URL } from './update-remote'

export const DEFAULT_RELEASE_REPO_SLUG = githubRepoSlug(OFFICIAL_REPO_HTTPS_URL) ?? 'xtcamille/hermes-forx'

export interface ReleaseAssetInfo {
  name: string
  url: string
  size: number | null
}

export interface ReleaseUpdateCheckResult {
  behind: number
  updateAvailable: boolean
  targetSha: string
  commits: CompareCommit[]
  releaseTag: string
  releaseUrl: string | null
  assetUrl: string | null
  assetName: string | null
  assetSize: number | null
}

export function latestReleaseApiUrl(slug: string = DEFAULT_RELEASE_REPO_SLUG): string {
  return `https://api.github.com/repos/${slug}/releases/latest`
}

export function normalizeSemver(raw: string | null | undefined): [number, number, number] | null {
  if (typeof raw !== 'string') {
    return null
  }

  const cleaned = raw.trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned)

  if (!match) {
    return null
  }

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)

  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null
  }

  return [major, minor, patch]
}

export function isNewerReleaseVersion(currentVersion: string, candidateTag: string): boolean {
  const current = normalizeSemver(currentVersion)
  const candidate = normalizeSemver(candidateTag)

  if (!current || !candidate) {
    return false
  }

  for (let i = 0; i < 3; i++) {
    if (candidate[i] > current[i]) {
      return true
    }

    if (candidate[i] < current[i]) {
      return false
    }
  }

  return false
}

const IGNORED_ASSET_SUFFIXES = ['.txt', '.yml', '.yaml', '.blockmap', '.sig', '.asc', '.json', '.sha256']

function isCandidateBinaryAsset(name: string): boolean {
  const lower = name.toLowerCase()

  return !IGNORED_ASSET_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function matchesArchToken(name: string, arch: string): boolean {
  const lower = name.toLowerCase()

  if (arch === 'x64') {
    return /\b(x64|amd64|x86_64)\b|[-_](x64|amd64|x86_64)[-_.]/.test(lower)
  }

  if (arch === 'arm64') {
    return /\b(arm64|aarch64)\b|[-_](arm64|aarch64)[-_.]/.test(lower)
  }

  return lower.includes(arch.toLowerCase())
}

function hasConflictingArchToken(name: string, arch: string): boolean {
  const lower = name.toLowerCase()

  if (arch === 'x64') {
    return /\b(arm64|aarch64)\b|[-_](arm64|aarch64)[-_.]/.test(lower)
  }

  if (arch === 'arm64') {
    return /\b(x64|amd64|x86_64)\b|[-_](x64|amd64|x86_64)[-_.]/.test(lower)
  }

  return false
}

export function selectReleaseAsset(assets: unknown, platform: string, arch: string): ReleaseAssetInfo | null {
  if (!Array.isArray(assets)) {
    return null
  }

  const valid: ReleaseAssetInfo[] = []

  for (const entry of assets) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name.trim() : ''

    const url =
      typeof (entry as { browser_download_url?: unknown }).browser_download_url === 'string'
        ? (entry as { browser_download_url: string }).browser_download_url.trim()
        : ''

    const rawSize = (entry as { size?: unknown }).size
    const size = typeof rawSize === 'number' && Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null

    if (!name || !url.startsWith('https://') || !isCandidateBinaryAsset(name)) {
      continue
    }

    valid.push({ name, url, size })
  }

  if (valid.length === 0) {
    return null
  }

  const pickByExtensions = (extensions: string[]): ReleaseAssetInfo | null => {
    for (const ext of extensions) {
      const extMatches = valid.filter(asset => asset.name.toLowerCase().endsWith(ext))

      const archMatch = extMatches.find(asset => matchesArchToken(asset.name, arch))

      if (archMatch) {
        return archMatch
      }

      const neutralMatch = extMatches.find(asset => !hasConflictingArchToken(asset.name, arch))

      if (neutralMatch) {
        return neutralMatch
      }

      if (extMatches[0]) {
        return extMatches[0]
      }
    }

    return null
  }

  if (platform === 'win32') {
    return pickByExtensions(['.exe', '.msi'])
  }

  if (platform === 'darwin') {
    return pickByExtensions(['.zip', '.dmg'])
  }

  if (platform === 'linux') {
    return pickByExtensions(['.appimage', '.deb', '.rpm'])
  }

  return null
}

function cleanReleaseNoteLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S+$/i, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .trim()
}

export function parseReleaseNotesToCommits(release: {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  author?: { login?: unknown } | null
}): CompareCommit[] {
  const tag = typeof release?.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : 'latest'
  const author = typeof release?.author?.login === 'string' ? release.author.login : ''
  const publishedMs = typeof release?.published_at === 'string' ? Date.parse(release.published_at) : NaN
  const at = Number.isFinite(publishedMs) ? publishedMs : 0
  const body = typeof release?.body === 'string' ? release.body : ''

  const bullets: string[] = []

  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim()

    if (!trimmed || trimmed.startsWith('#') || /^full changelog:/i.test(trimmed)) {
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const cleaned = cleanReleaseNoteLine(trimmed)

      if (cleaned) {
        bullets.push(cleaned)
      }
    }
  }

  if (bullets.length === 0) {
    for (const rawLine of body.split(/\r?\n/)) {
      const trimmed = rawLine.trim()

      if (!trimmed || trimmed.startsWith('#') || /^full changelog:/i.test(trimmed)) {
        continue
      }

      const cleaned = cleanReleaseNoteLine(trimmed)

      if (cleaned) {
        bullets.push(cleaned)
      }
    }
  }

  if (bullets.length === 0) {
    const title = typeof release?.name === 'string' && release.name.trim() ? release.name.trim() : `Release ${tag}`
    bullets.push(`feat: ${title}`)
  }

  return bullets.map((summary, idx) => ({
    sha: `${tag}-${idx}`,
    summary,
    author,
    at
  }))
}

export function parseReleaseUpdateCheck(
  payload: unknown,
  options: { currentVersion: string; platform: string; arch: string }
): ReleaseUpdateCheckResult | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const rawTag = (payload as { tag_name?: unknown }).tag_name
  const releaseTag = typeof rawTag === 'string' ? rawTag.trim() : ''

  if (!releaseTag || !normalizeSemver(releaseTag)) {
    return null
  }

  const updateAvailable = isNewerReleaseVersion(options.currentVersion, releaseTag)
  const asset = selectReleaseAsset((payload as { assets?: unknown }).assets, options.platform, options.arch)

  const commits = updateAvailable
    ? parseReleaseNotesToCommits(
        payload as {
          tag_name?: unknown
          name?: unknown
          body?: unknown
          published_at?: unknown
          author?: { login?: unknown } | null
        }
      )
    : []

  const rawHtmlUrl = (payload as { html_url?: unknown }).html_url
  const releaseUrl = typeof rawHtmlUrl === 'string' && rawHtmlUrl.startsWith('https://') ? rawHtmlUrl : null
  const normalizedCurrent = options.currentVersion.trim().replace(/^v/i, '')

  return {
    behind: updateAvailable ? Math.max(1, commits.length) : 0,
    updateAvailable,
    targetSha: updateAvailable ? releaseTag : `v${normalizedCurrent}`,
    commits,
    releaseTag,
    releaseUrl,
    assetUrl: asset?.url ?? null,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? null
  }
}

export interface WindowsInstallerHandoffOptions {
  installerPath: string
  installDir: string
  desktopPid: number
  relaunchExe: string
}

export function buildWindowsInstallerHandoff(options: WindowsInstallerHandoffOptions): {
  command: string
  args: string[]
  env: Record<string, string>
  detached: false
} {
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$pidToWait = [int]$env:FORX_UPDATE_DESKTOP_PID',
    'if ($pidToWait -gt 0) { Wait-Process -Id $pidToWait -Timeout 20 -ErrorAction SilentlyContinue }',
    'Start-Sleep -Milliseconds 600',
    '$installer = $env:FORX_UPDATE_INSTALLER',
    '$installDir = $env:FORX_UPDATE_INSTALL_DIR',
    '$relaunchExe = $env:FORX_UPDATE_RELAUNCH_EXE',
    '$argStr = if ($installDir) { "/S /D=$installDir" } else { "/S" }',
    '$proc = Start-Process -FilePath $installer -ArgumentList $argStr -Wait -PassThru',
    'if ($null -eq $proc -or $proc.ExitCode -ne 0) {',
    '  Start-Process -FilePath $installer',
    '  exit 0',
    '}',
    'if ($relaunchExe -and (Test-Path -LiteralPath $relaunchExe)) {',
    '  Start-Process -FilePath $relaunchExe',
    '}'
  ].join('\n')

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')

  return {
    command: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'start',
      '',
      '/b',
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ],
    env: {
      FORX_UPDATE_INSTALLER: options.installerPath,
      FORX_UPDATE_INSTALL_DIR: options.installDir,
      FORX_UPDATE_DESKTOP_PID: String(options.desktopPid),
      FORX_UPDATE_RELAUNCH_EXE: options.relaunchExe
    },
    detached: false
  }
}

export interface MacInstallerHandoffOptions {
  archivePath: string
  targetAppBundle: string | null
  desktopPid: number
}

export function buildMacInstallerHandoff(options: MacInstallerHandoffOptions): {
  command: string
  args: string[]
  env: Record<string, string>
  detached: true
} {
  const bashScript = [
    'set +e',
    'PID_TO_WAIT="${FORX_UPDATE_DESKTOP_PID:-0}"',
    'if [ "$PID_TO_WAIT" -gt 0 ] 2>/dev/null; then',
    '  for _ in $(seq 1 40); do',
    '    kill -0 "$PID_TO_WAIT" 2>/dev/null || break',
    '    sleep 0.5',
    '  done',
    'fi',
    'ARCHIVE="$FORX_UPDATE_ARCHIVE"',
    'TARGET_APP="$FORX_UPDATE_TARGET_APP"',
    'LOWER_ARCHIVE=$(printf "%s" "$ARCHIVE" | tr "[:upper:]" "[:lower:]")',
    'if [ -n "$TARGET_APP" ] && [ -w "$(dirname "$TARGET_APP")" ]; then',
    '  STAGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/forx-update.XXXXXX")',
    '  if [[ "$LOWER_ARCHIVE" == *.zip ]]; then',
    '    if ditto -x -k "$ARCHIVE" "$STAGE_DIR"; then',
    '      NEW_APP=$(find "$STAGE_DIR" -maxdepth 2 -name "*.app" -print -quit)',
    '      if [ -n "$NEW_APP" ]; then',
    '        rm -rf "$TARGET_APP" && mv "$NEW_APP" "$TARGET_APP"',
    '        xattr -cr "$TARGET_APP" 2>/dev/null || true',
    '        rm -rf "$STAGE_DIR"',
    '        open -n "$TARGET_APP"',
    '        exit 0',
    '      fi',
    '    fi',
    '  elif [[ "$LOWER_ARCHIVE" == *.dmg ]]; then',
    '    MNT_DIR="$STAGE_DIR/mnt"',
    '    mkdir -p "$MNT_DIR"',
    '    if hdiutil attach "$ARCHIVE" -nobrowse -readonly -mountpoint "$MNT_DIR" >/dev/null 2>&1; then',
    '      NEW_APP=$(find "$MNT_DIR" -maxdepth 2 -name "*.app" -print -quit)',
    '      if [ -n "$NEW_APP" ] && ditto "$NEW_APP" "$TARGET_APP"; then',
    '        hdiutil detach "$MNT_DIR" -force >/dev/null 2>&1 || true',
    '        xattr -cr "$TARGET_APP" 2>/dev/null || true',
    '        rm -rf "$STAGE_DIR"',
    '        open -n "$TARGET_APP"',
    '        exit 0',
    '      fi',
    '      hdiutil detach "$MNT_DIR" -force >/dev/null 2>&1 || true',
    '    fi',
    '  fi',
    '  rm -rf "$STAGE_DIR"',
    'fi',
    'open "$ARCHIVE"'
  ].join('\n')

  return {
    command: '/bin/bash',
    args: ['-c', bashScript],
    env: {
      FORX_UPDATE_ARCHIVE: options.archivePath,
      FORX_UPDATE_TARGET_APP: options.targetAppBundle ?? '',
      FORX_UPDATE_DESKTOP_PID: String(options.desktopPid)
    },
    detached: true
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface DownloadReleaseAssetOptions {
  url: string
  destPath: string
  expectedSize?: number | null
  onProgress?: (progress: { message: string; percent: number | null }) => void
}

export async function downloadReleaseAsset({
  url,
  destPath,
  expectedSize = null,
  onProgress
}: DownloadReleaseAssetOptions): Promise<string> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const partPath = `${destPath}.part`
  const fileName = path.basename(destPath)

  try {
    fs.unlinkSync(partPath)
  } catch {
    // ignore missing temp file
  }

  const downloadWithRedirects = (currentUrl: string, redirectsLeft: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const req = https.get(
        currentUrl,
        {
          agent: updateCheckAgent(currentUrl),
          headers: {
            Accept: 'application/octet-stream, */*',
            'User-Agent': 'forx-desktop-updater'
          },
          timeout: 30_000
        },
        res => {
          const status = res.statusCode ?? 500

          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location
            res.resume()

            if (!location || redirectsLeft <= 0) {
              reject(new Error(`Redirect failed while downloading ${fileName} (HTTP ${status}).`))

              return
            }

            const nextUrl = new URL(location, currentUrl).toString()
            downloadWithRedirects(nextUrl, redirectsLeft - 1).then(resolve, reject)

            return
          }

          if (status >= 400) {
            res.resume()
            reject(new Error(`Failed to download ${fileName} (HTTP ${status}).`))

            return
          }

          const headerLen = Number.parseInt(String(res.headers['content-length'] ?? ''), 10)
          const totalBytes = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : expectedSize
          const out = fs.createWriteStream(partPath)
          let downloadedBytes = 0
          let lastEmitMs = 0

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length
            const now = Date.now()

            if (onProgress && now - lastEmitMs >= 200) {
              lastEmitMs = now

              const ratio = totalBytes && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : null
              const percent = ratio !== null ? Math.round(5 + ratio * 80) : null

              const message =
                totalBytes && totalBytes > 0
                  ? `Downloading ${fileName} (${formatMb(downloadedBytes)} / ${formatMb(totalBytes)})…`
                  : `Downloading ${fileName} (${formatMb(downloadedBytes)})…`

              onProgress({ message, percent })
            }
          })

          res.on('error', err => {
            out.destroy()
            reject(err)
          })

          out.on('error', err => {
            res.destroy()
            reject(err)
          })

          out.on('finish', () => {
            out.close(() => {
              if (downloadedBytes <= 0) {
                reject(new Error(`Downloaded installer ${fileName} is empty.`))

                return
              }

              if (expectedSize && expectedSize > 0 && downloadedBytes !== expectedSize) {
                reject(
                  new Error(
                    `Incomplete download for ${fileName}: received ${downloadedBytes} of ${expectedSize} bytes.`
                  )
                )

                return
              }

              resolve()
            })
          })

          res.pipe(out)
        }
      )

      req.on('timeout', () => req.destroy(new Error(`Download timed out for ${fileName}.`)))
      req.on('error', reject)
    })

  await downloadWithRedirects(url, 5)
  fs.renameSync(partPath, destPath)

  return destPath
}

