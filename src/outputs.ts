import { spawnSync } from 'node:child_process'

import * as core from '@actions/core'

// How long `nic outputs --wait` may poll for the fields that materialize
// after `nic deploy` returns (the Argo CD server writes its own initial
// admin secret on first start, and the gateway address waits on the load
// balancer). After the action's own Application wait everything is normally
// already there and the command returns at once. With wait disabled this
// window is the only grace period, superseding the short polls the previous
// kubectl extraction did.
const OUTPUTS_WAIT_TIMEOUT = '120s'

// The platform outputs as `nic outputs --format json` reports them, mapped
// to this action's output names. The layout knowledge behind each field
// (which Secret, which key, which Service) lives in NIC itself, the same
// binary that deployed the platform, so it cannot go stale here
// (nebari-infrastructure-core#606).
const FIELDS: { key: string; output: string; secret: boolean }[] = [
  { key: 'domain', output: 'domain', secret: false },
  { key: 'keycloak_issuer_url', output: 'keycloak-issuer-url', secret: false },
  {
    key: 'keycloak_admin_password',
    output: 'keycloak-admin-password',
    secret: true
  },
  {
    key: 'keycloak_realm_admin_password',
    output: 'keycloak-realm-admin-password',
    secret: true
  },
  {
    key: 'argocd_admin_password',
    output: 'argocd-admin-password',
    secret: true
  },
  { key: 'gateway_address', output: 'gateway-address', secret: false }
]

// Degrade every platform output to empty with a warning. `nic outputs` is
// all-or-nothing: it exits non-zero naming each field it could not resolve
// rather than reporting an empty value as success, and output extraction
// must never be the thing that fails an otherwise successful deploy.
function degrade(reason: string): void {
  core.warning(`platform output extraction failed: ${reason}`)
  for (const field of FIELDS) core.setOutput(field.output, '')
}

/**
 * Export the platform outputs beyond kubeconfig/nic-binary via
 * `nic outputs`: admin credentials (masked), the gateway address, and the
 * domain-derived URLs. On any failure every platform output degrades to ''
 * with a warning naming what could not be resolved and why. Nothing here
 * fails the action.
 */
export function extractPlatformOutputs(nic: string, configPath: string): void {
  core.startGroup('Extract platform outputs')
  try {
    const res = spawnSync(
      nic,
      [
        'outputs',
        '-f',
        configPath,
        '--format',
        'json',
        '--show-secrets',
        '--wait',
        '--timeout',
        OUTPUTS_WAIT_TIMEOUT
      ],
      { encoding: 'utf8' }
    )

    // nic sends progress to stderr by design, keeping the JSON on stdout
    // parseable. Surface it in the log group either way. On failure the
    // final stderr line names each unresolved field and why.
    const stderr = (res.stderr || '').toString().trim()
    if (stderr) core.info(stderr)

    if (res.error) {
      degrade(`failed to run nic outputs: ${res.error.message}`)
      return
    }
    if (res.status !== 0) {
      if (stderr.includes('unknown command "outputs"')) {
        degrade(
          'this nic version predates `nic outputs`, so platform outputs ' +
            'will be empty. Upgrade nic-version to populate them.'
        )
      } else {
        degrade(stderr || `nic outputs exited with status ${res.status}`)
      }
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(res.stdout.toString()) as Record<string, unknown>
    } catch {
      degrade('nic outputs did not print valid JSON')
      return
    }

    for (const field of FIELDS) {
      const raw = payload[field.key]
      const value = typeof raw === 'string' ? raw : ''
      if (field.secret) {
        // Mask before the value goes anywhere near an output. Only whether
        // it was found is ever logged.
        if (value) core.setSecret(value)
        core.info(
          `${field.output}: ${value ? '(found, masked)' : '(not found)'}`
        )
      } else {
        core.info(`${field.output}: ${value || '(not found)'}`)
      }
      core.setOutput(field.output, value)
    }
  } catch (err) {
    degrade(err instanceof Error ? err.message : String(err))
  } finally {
    core.endGroup()
  }
}
