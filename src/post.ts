import * as core from '@actions/core'

import { run as exec } from './nic.js'

// Post step destroys the deployment when the job ends, and runs even when
// the job failed or was cancelled. Skipped when deploy never started or the
// caller set destroy: false.
function destroy(): void {
  if (core.getState('deployStarted') !== 'true') {
    core.info('Deploy never started; nothing to destroy.')
    return
  }
  if (core.getState('destroy') !== 'true') {
    core.warning('destroy: false — leaving the deployment running.')
    return
  }

  const nic = core.getState('nicBinary')
  const config = core.getState('config')

  const args = ['destroy', '-f', config, '--auto-approve']
  if (core.getState('force') === 'true') args.push('--force')

  // endGroup in finally: a failed destroy's output must not render collapsed.
  core.startGroup('nic destroy')
  try {
    exec(nic, args)
  } finally {
    core.endGroup()
  }
}

/** The post step of the action: destroy the deployment when the job ends. */
export function run(): void {
  try {
    destroy()
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}
