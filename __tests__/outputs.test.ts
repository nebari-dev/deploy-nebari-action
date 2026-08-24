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
  jest.clearAllMocks()
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
        expect.stringMatching(/^[0-9]+[ms]/)
      ],
      expect.objectContaining({ encoding: 'utf8' })
    )
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

  it('degrades every output to empty when nic outputs fails', () => {
    // nic outputs is all-or-nothing: any unresolved field exits non-zero
    // naming it. The action must surface that as a warning, not a failure.
    spawnSync.mockReturnValue(
      fail(
        'Error: unresolved platform outputs: gateway_address (load balancer not ready)'
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
      expect.stringContaining('did not print valid JSON')
    )
    for (const name of PLATFORM_OUTPUTS) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.setFailed).not.toHaveBeenCalled()
  })

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
