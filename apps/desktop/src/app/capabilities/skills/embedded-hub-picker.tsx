import { memo, useCallback } from 'react'

import { Button } from '@/components/ui/button'
import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { useStoreSelector } from '@/lib/use-session-slice'
import {
  $hubActions,
  installHubSkill,
  notifyHubActionFailed,
  UPDATE_ALL_KEY,
  updateHubSkills
} from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'

import { EmbeddedCatalogPane } from '../embedded-catalog-pane'

// The REAL Skills Hub page (docs site) embedded as a one-click picker — the
// same trick the Bot Mode agent editor uses. `?embed=picker` hides the docs
// chrome and adds a "+ Add to this Agent" button per card, which posts
//   { type: 'hermes-skill-pick', name, identifier, installCmd, source }
// to the parent window. We validate the origin and route the install through
// the standard hub action pipeline (background action + tailed log + Skills
// list invalidation), scoped to the Capabilities profile selector.
const HUB_ORIGIN = 'https://xtcamille.github.io'
const HUB_PICKER_URL = `${HUB_ORIGIN}/hermes-forx/skills?embed=picker`

interface SkillPickMessage {
  identifier?: string
  installCmd?: string
  name?: string
  source?: string
  type?: string
}

interface EmbeddedHubPickerProps {
  /** Kept mounted but fully hidden (display:none). The Capabilities view uses
   *  this to preserve the loaded hub iframe across tab switches — a plain
   *  unmount would reload the whole docs site on every return to Skills. */
  hidden?: boolean
  /** Names of skills already installed in the scoped profile — a pick that
   *  matches is refused with a toast instead of re-running the install. */
  installedNames: ReadonlySet<string>
  /** Capabilities profile-scope override — installs land in THIS profile;
   *  undefined/null targets the app-wide active profile. */
  profile?: ProfileScope
}

/** The Skills Hub browser for the Skills tab: a resizable iframe of the live
 *  hub where every card installs with one click. Expanded by default —
 *  discovery IS the point — with a collapse toggle (persisted, like every
 *  other pane) and an update-all action. Memoized: the iframe must not sit in
 *  the parent's keystroke/re-render path. */
export const EmbeddedHubPicker = memo(function EmbeddedHubPicker({
  hidden = false,
  installedNames,
  profile
}: EmbeddedHubPickerProps) {
  const { t } = useI18n()
  const h = t.skills.hub
  // Subscribe to the ONE flag this header renders, not the whole action map —
  // $hubActions churns on every tailed log line during an install.
  const updating = useStoreSelector($hubActions, actions => actions[UPDATE_ALL_KEY]?.running ?? false)

  const onHubMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin !== HUB_ORIGIN) {
        return
      }

      const data = event.data as SkillPickMessage | null

      if (!data || data.type !== 'hermes-skill-pick' || !data.name) {
        return
      }

      const target = String(data.identifier || data.name)
      const label = String(data.name)

      if (installedNames.has(label) || installedNames.has(target)) {
        notify({ kind: 'success', title: h.alreadyInstalled(label), message: '' })

        return
      }

      notify({ kind: 'success', title: h.installStarted(label), message: h.actionLog })
      void installHubSkill(target, profile).catch(err => notifyHubActionFailed(err, h.actionFailed, label, profile))
    },
    [h, installedNames, profile]
  )

  const updateAll = () => {
    notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
    void updateHubSkills(profile).catch(err => notifyError(err, h.actionFailed))
  }

  return (
    <EmbeddedCatalogPane
      actions={
        <Button disabled={updating} onClick={updateAll} size="xs" type="button" variant="text">
          {updating && <Loader2 className="size-3 animate-spin" />}
          {updating ? h.updating : h.updateAll}
        </Button>
      }
      browseLabel={h.pickerBrowse}
      hidden={hidden}
      hideLabel={h.pickerHide}
      hint={h.pickerHint}
      onMessage={onHubMessage}
      paneId="capabilities-hub"
      src={HUB_PICKER_URL}
      title={h.pickerTitle}
    />
  )
})
