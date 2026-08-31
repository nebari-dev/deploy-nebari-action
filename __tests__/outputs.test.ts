/**
 * Unit tests for src/outputs.ts
 *
 * child_process is mocked so no real nic runs. The module is a thin
 * passthrough over `nic outputs --format json`, so the tests exercise the
 * argument contract, the JSON-to-output mapping, secret masking order, and
 * the degrade-to-empty path that keeps extraction from ever failing the
 * action.
 */
import { jest } from '@jest/globals'

import * as core from '../__fixtures__/core.js'

interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

const spawnSync =
  jest.fn<(cmd: string, args: string[], opts?: object) => SpawnResult>()

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('node:child_process', () => ({ spawnSync }))

const { extractPlatformOutputs } = await import('../src/outputs.js')

const NIC = '/tmp/nic'
const CONFIG = '/workspace/config.yaml'

const HEALTHY_JSON = JSON.stringify({
  domain: 'nebari.local',
  keycloak_issuer_url: 'https://keycloak.nebari.local',
  keycloak_admin_password: 'kc-master-pass',
  keycloak_realm_admin_password: 'kc-realm-pass',
  argocd_admin_password: 'argo-pass',
  gateway_address: '10.89.0.2'
})

const ok = (stdout: string, stderr = ''): SpawnResult => ({
  status: 0,
  stdout,
  stderr
})
const fail = (stderr: string): SpawnResult => ({
  status: 1,
  stdout: '',
  stderr
})

const PLATFORM_OUTPUTS = [
  'domain',
  'keycloak-issuer-url',
  'keycloak-admin-password',
  'keycloak-realm-admin-password',
  'argocd-admin-password',
  'gateway-address'
]

afterEach(() => {
  jest.resetAllMocks()
})

describe('extractPlatformOutputs', () => {
  it('sets every output from the nic outputs JSON', () => {
    spawnSync.mockReturnValue(ok(HEALTHY_JSON))

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.setOutput).toHaveBeenCalledWith('domain', 'nebari.local')
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-issuer-url',
      'https://keycloak.nebari.local'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-admin-password',
      'kc-master-pass'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-realm-admin-password',
      'kc-realm-pass'
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'argocd-admin-password',
      'argo-pass'
    )
    expect(core.setOutput).toHaveBeenCalledWith('gateway-address', '10.89.0.2')
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('invokes nic outputs with waiting, JSON, and secrets enabled', () => {
    spawnSync.mockReturnValue(ok(HEALTHY_JSON))

    extractPlatformOutputs(NIC, CONFIG)

    expect(spawnSync).toHaveBeenCalledWith(
      NIC,
      [
        'outputs',
        '-f',
        CONFIG,
        '--format',
        'json',
        '--show-secrets',
        '--wait',
        '--timeout',
        expect.stringMatching(/^[1-9][0-9]*s$/)
      ],
      // The process timeout backstops a hung nic (its own --timeout is the
      // real bound), so it only needs to exceed the --wait window.
      expect.objectContaining({
        encoding: 'utf8',
        timeout: expect.any(Number),
        maxBuffer: 64 * 1024 * 1024
      })
    )
    const [, args, opts] = spawnSync.mock.calls[0] as [
      string,
      string[],
      { timeout: number }
    ]
    const waitSeconds = parseInt(args[args.indexOf('--timeout') + 1], 10)
    expect(opts.timeout).toBeGreaterThan(waitSeconds * 1000)
  })

  it('masks every credential before outputting it', () => {
    spawnSync.mockReturnValue(ok(HEALTHY_JSON))

    extractPlatformOutputs(NIC, CONFIG)

    for (const pass of ['kc-master-pass', 'kc-realm-pass', 'argo-pass']) {
      expect(core.setSecret).toHaveBeenCalledWith(pass)
      const masked =
        core.setSecret.mock.invocationCallOrder[
          core.setSecret.mock.calls.findIndex(([v]) => v === pass)
        ]
      const output =
        core.setOutput.mock.invocationCallOrder[
          core.setOutput.mock.calls.findIndex(([, v]) => v === pass)
        ]
      expect(masked).toBeLessThan(output)
    }
  })

  it('never logs a credential value', () => {
    spawnSync.mockReturnValue(ok(HEALTHY_JSON))

    extractPlatformOutputs(NIC, CONFIG)

    for (const call of core.info.mock.calls) {
      expect(call[0]).not.toContain('kc-master-pass')
      expect(call[0]).not.toContain('kc-realm-pass')
      expect(call[0]).not.toContain('argo-pass')
    }
  })

  it('surfaces nic progress from stderr on success', () => {
    spawnSync.mockReturnValue(
      ok(HEALTHY_JSON, 'Waiting for platform outputs: gateway_address')
    )

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.info).toHaveBeenCalledWith(
      'Waiting for platform outputs: gateway_address'
    )
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('masks every credential before echoing nic stderr', () => {
    // Runner masking only applies to log lines emitted after setSecret, so
    // the stderr echo must come last even though nic is not expected to put
    // secrets there.
    spawnSync.mockReturnValue(ok(HEALTHY_JSON, 'progress line'))

    extractPlatformOutputs(NIC, CONFIG)

    const echo =
      core.info.mock.invocationCallOrder[
        core.info.mock.calls.findIndex(([m]) => m === 'progress line')
      ]
    for (const order of core.setSecret.mock.invocationCallOrder) {
      expect(order).toBeLessThan(echo)
    }
    expect(core.setSecret).toHaveBeenCalledTimes(3)
  })

  it('degrades every output to empty when nic outputs fails', () => {
    // nic outputs reports all fields or none: any unresolved field exits
    // non-zero naming it. The action must surface that as a warning, not a
    // failure.
    spawnSync.mockReturnValue(
      fail(
        JSON.stringify({
          level: 'ERROR',
          msg: 'Command execution failed',
          error:
            'unresolved platform outputs: gateway_address (load balancer not ready)'
        })
      )
    )

    extractPlatformOutputs(NIC, CONFIG)

    for (const name of PLATFORM_OUTPUTS) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('unresolved platform outputs: gateway_address')
    )
    expect(core.setSecret).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('never echoes raw stderr from a failed run', () => {
    // A failed run may have resolved credentials internally before the
    // failure (upstream resolves field by field), and no setSecret has run
    // on this path, so nothing from stderr may reach the log except the
    // extracted slog `error` fields. Plain-text stderr (cobra errors,
    // future upstream text that might embed a value) must be dropped
    // entirely, falling back to the exit status.
    const leaked = 'oops secret-value-123 leaked'
    spawnSync.mockReturnValue(fail(leaked))

    extractPlatformOutputs(NIC, CONFIG)

    for (const call of [...core.info.mock.calls, ...core.warning.mock.calls]) {
      expect(call[0]).not.toContain('secret-value-123')
    }
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('exited with status 1')
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('extracts the error from slog JSON stderr for the warning', () => {
    // nic's stderr diagnostics are slog JSON lines; the warning should carry
    // the prose error, not the raw JSON envelope.
    spawnSync.mockReturnValue(
      fail(
        JSON.stringify({
          time: '2026-08-24T18:00:00Z',
          level: 'ERROR',
          msg: 'Command execution failed',
          error:
            'unresolved platform outputs: gateway_address (load balancer not ready)'
        })
      )
    )

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.warning).toHaveBeenCalledWith(
      'platform output extraction failed: unresolved platform outputs: ' +
        'gateway_address (load balancer not ready)'
    )
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('explains the degrade when nic predates the outputs command', () => {
    spawnSync.mockReturnValue(
      fail('Error: unknown command "outputs" for "nic"')
    )

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('predates `nic outputs`')
    )
    for (const name of PLATFORM_OUTPUTS) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('degrades when nic cannot be started at all', () => {
    spawnSync.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT')
    })

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('ENOENT'))
    for (const name of PLATFORM_OUTPUTS) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('degrades when the payload is not valid JSON', () => {
    spawnSync.mockReturnValue(ok('not-json'))

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('did not print a valid JSON object')
    )
    for (const name of PLATFORM_OUTPUTS) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it.each(['null', '[]', '"str"', '42'])(
    'degrades when the payload is valid JSON but not an object (%s)',
    (stdout) => {
      // JSON.parse succeeds on these, so without an explicit object check
      // they would either crash the field loop (null) or silently map every
      // output to '' with no warning at all.
      spawnSync.mockReturnValue(ok(stdout))

      extractPlatformOutputs(NIC, CONFIG)

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('did not print a valid JSON object')
      )
      for (const name of PLATFORM_OUTPUTS) {
        expect(core.setOutput).toHaveBeenCalledWith(name, '')
      }
      expect(core.setFailed).not.toHaveBeenCalled()
    }
  )

  it('outputs empty for a field missing from the payload without masking it', () => {
    // Defensive: a payload from a newer/older nic that drops or nulls a
    // field must map to '' (the documented degrade value), never to
    // 'null'/'undefined' strings, and must not register an empty mask.
    const partial = JSON.parse(HEALTHY_JSON) as Record<string, unknown>
    delete partial.gateway_address
    partial.argocd_admin_password = null
    spawnSync.mockReturnValue(ok(JSON.stringify(partial)))

    extractPlatformOutputs(NIC, CONFIG)

    expect(core.setOutput).toHaveBeenCalledWith('gateway-address', '')
    expect(core.setOutput).toHaveBeenCalledWith('argocd-admin-password', '')
    expect(core.setSecret).not.toHaveBeenCalledWith('')
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
