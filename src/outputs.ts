import { spawnSync } from 'node:child_process'

import * as core from '@actions/core'

// How long `nic outputs --wait` may poll for the fields that materialize
// after `nic deploy` returns (the Argo CD server writes its own initial
// admin secret on first start, and the gateway address waits on the load
// balancer). After the action's own Application wait everything is normally
// already there and the command returns at once. With wait disabled this
// window is the only grace period.
const OUTPUTS_WAIT_TIMEOUT_SECONDS = 300

// `nic outputs` (and every flag this module passes it) shipped in v0.14.0
// (nebari-infrastructure-core#609). Older nics reject the command or a flag
// with a cobra plain-text error; both are matched below so the degrade
// warning names the version that fixes it instead of a bare exit status.
const MIN_OUTPUTS_VERSION = 'v0.14.0'

// The platform outputs as `nic outputs --format json` reports them, mapped
// to this action's output names. The layout knowledge behind each field
// (which Secret, which key, which Service) lives in NIC itself, the same
// binary that deployed the platform, so it cannot go stale here
// (nebari-infrastructure-core#606). Keys missing from the payload map to ''
// and extra keys are ignored, so newer nic versions can add fields without
// breaking extraction.
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

// Degrade every platform output to empty with a warning. `nic outputs`
// reports all fields or none: it exits non-zero naming each field it could
// not resolve rather than reporting an empty value as success, and output
// extraction must never be the thing that fails an otherwise successful
// deploy. All-or-nothing is a property of the reported payload only: a
// failed run may still have resolved credentials internally (upstream
// resolves field by field and keeps earlier successes), and no setSecret
// has run at that point, so `reason` must never carry raw nic stderr.
function degrade(reason: string): void {
  core.warning(`platform output extraction failed: ${reason}`)
  for (const field of FIELDS) core.setOutput(field.output, '')
}

// nic writes stderr diagnostics as structured slog JSON lines. Pull the
// error messages out so the degrade warning reads as prose ("unresolved
// platform outputs: ...") instead of raw JSON. Returns '' when no line
// carries one (e.g. cobra's plain-text unknown-command error).
function slogErrors(stderr: string): string {
  const errors: string[] = []
  for (const line of stderr.split('\n')) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.error === 'string') errors.push(entry.error)
    } catch {
      // Not a slog JSON line; nothing to extract.
    }
  }
  return errors.join('; ')
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
    const args = [
      'outputs',
      '-f',
      configPath,
      '--format',
      'json',
      '--show-secrets',
      '--wait',
      '--timeout',
      `${OUTPUTS_WAIT_TIMEOUT_SECONDS}s`
    ]
    core.info(`$ ${nic} ${args.join(' ')}`)
    const res = spawnSync(nic, args, {
      encoding: 'utf8',
      // nic enforces --timeout itself. The process timeout is a backstop
      // against a hung nic (e.g. an API-server stall), with slack so nic
      // normally gets to report its own, more specific timeout error.
      timeout: (OUTPUTS_WAIT_TIMEOUT_SECONDS + 60) * 1000,
      maxBuffer: 64 * 1024 * 1024
    })

    // nic sends progress to stderr by design, keeping the JSON on stdout
    // parseable. On failure it carries the line naming each unresolved
    // field and why. A failed run may have resolved credentials internally
    // before the failure and nothing has been setSecret-masked yet, so raw
    // stderr from a failed run is never echoed. nic's error text is built
    // from field, namespace, secret and key names, never values so the
    // extracted slog `error` fields are the widest slice that is safe
    // to emit unmasked.
    const stderr = (res.stderr || '').toString().trim()

    if (res.error) {
      const detail = slogErrors(stderr)
      degrade(
        `failed to run nic outputs: ${res.error.message}` +
          (detail ? ` (${detail})` : '')
      )
      return
    }
    if (res.status !== 0) {
      if (
        stderr.includes('unknown command "outputs"') ||
        stderr.includes('unknown flag')
      ) {
        degrade(
          'this nic version does not support `nic outputs` as this action ' +
            `invokes it (requires ${MIN_OUTPUTS_VERSION} or newer), so ` +
            'platform outputs will be empty. Upgrade nic-version to ' +
            'populate them.'
        )
      } else {
        degrade(
          slogErrors(stderr) ||
            `nic outputs exited with status ${res.status}` +
              (res.signal ? ` (signal ${res.signal})` : '')
        )
      }
      return
    }

    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(res.stdout.toString())
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error('not an object')
      }
      payload = parsed as Record<string, unknown>
    } catch {
      degrade('nic outputs did not print a valid JSON object')
      return
    }

    // Register every credential with the runner before any success-path
    // logging, the stderr echo included: masking only applies to log lines
    // emitted after the value was registered.
    for (const field of FIELDS) {
      const raw = payload[field.key]
      if (field.secret && typeof raw === 'string' && raw) core.setSecret(raw)
    }

    if (stderr) core.info(stderr)

    for (const field of FIELDS) {
      const raw = payload[field.key]
      const value = typeof raw === 'string' ? raw : ''
      if (field.secret) {
        // Only whether the credential was found is ever logged.
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
