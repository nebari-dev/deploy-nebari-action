/**
 * Unit tests for src/outputs.ts
 *
 * child_process is mocked so no real kubectl runs; the filesystem is real
 * (temp dirs) for the config file and the extracted CA. The sleep between
 * poll attempts is neutralized by stubbing Atomics.wait.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

const { parseDomain, extractPlatformOutputs } =
  await import('../src/outputs.js')

const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout, stderr: '' })
const fail = (): SpawnResult => ({ status: 1, stdout: '', stderr: 'nope' })

const b64 = (s: string): string => Buffer.from(s).toString('base64')

let tmpDir: string

beforeAll(() => {
  // Poll sleeps go through Atomics.wait; stub it so retry tests run
  // instantly.
  jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outputs-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  jest.clearAllMocks()
})

function writeConfig(content: string): string {
  const p = path.join(tmpDir, 'config.yaml')
  fs.writeFileSync(p, content)
  return p
}

// Dispatch mocked kubectl calls on distinctive argument fragments.
function mockKubectl(
  handlers: Record<string, () => SpawnResult>
): jest.Mock<(cmd: string, args: string[], opts?: object) => SpawnResult> {
  return spawnSync.mockImplementation((_cmd, args) => {
    const line = args.join(' ')
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (line.includes(fragment)) return handler()
    }
    return fail()
  })
}

// The happy-path cluster: the keycloak route, every secret, and the gateway
// address all resolve.
function mockHealthyCluster(): void {
  mockKubectl({
    'httproutes.gateway.networking.k8s.io keycloak': () =>
      ok('keycloak.nebari.local'),
    'secret keycloak-admin-credentials': () => ok(b64('kc-master-pass')),
    'secret nebari-realm-admin-credentials': () => ok(b64('kc-realm-pass')),
    'secret argocd-initial-admin-secret': () => ok(b64('argo-pass')),
    'ingress[0].ip': () => ok('10.89.0.2')
  })
}

describe('parseDomain', () => {
  it('parses a top-level domain field', () => {
    expect(
      parseDomain(writeConfig('project_name: x\ndomain: nebari.local\n'))
    ).toBe('nebari.local')
  })

  it('strips quotes', () => {
    expect(parseDomain(writeConfig('domain: "nebari.example.com"\n'))).toBe(
      'nebari.example.com'
    )
  })

  it('returns empty when the config has no domain', () => {
    expect(parseDomain(writeConfig('project_name: x\n'))).toBe('')
  })

  it('returns empty when the file is unreadable', () => {
    expect(parseDomain(path.join(tmpDir, 'missing.yaml'))).toBe('')
  })
})

describe('extractPlatformOutputs', () => {
  it('sets every output from a healthy platform', () => {
    mockHealthyCluster()
    // No domain in the config: the deployed HTTPRoute alone must provide it.
    const config = writeConfig('project_name: x\n')

    extractPlatformOutputs('/kubeconfig', config)

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
    expect(core.setOutput).toHaveBeenCalledWith('gateway-ip', '10.89.0.2')
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('masks every credential before outputting it', () => {
    mockHealthyCluster()

    extractPlatformOutputs('/kubeconfig', writeConfig('domain: nebari.local\n'))

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

  it('runs kubectl against the given kubeconfig', () => {
    mockHealthyCluster()

    extractPlatformOutputs('/kubeconfig', writeConfig('domain: nebari.local\n'))

    for (const call of spawnSync.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ KUBECONFIG: '/kubeconfig' })
        })
      )
    }
  })

  it('polls for the realm password before giving up', () => {
    let attempts = 0
    mockKubectl({
      'secret nebari-realm-admin-credentials': () =>
        ++attempts < 3 ? ok('') : ok(b64('late-realm-pass'))
    })

    extractPlatformOutputs('/kubeconfig', writeConfig('domain: d\n'))

    expect(attempts).toBe(3)
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-realm-admin-password',
      'late-realm-pass'
    )
  })

  it('prefers the deployed HTTPRoute hostname over the config domain', () => {
    // The cluster reflects NIC's defaulting; the config says something else
    // (e.g. an edited config since deploy). The deployed value must win.
    mockKubectl({
      'httproutes.gateway.networking.k8s.io keycloak': () =>
        ok('keycloak.cluster.example')
    })

    extractPlatformOutputs(
      '/kubeconfig',
      writeConfig('domain: config.example\n')
    )

    expect(core.setOutput).toHaveBeenCalledWith('domain', 'cluster.example')
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-issuer-url',
      'https://keycloak.cluster.example'
    )
  })

  it('falls back to the config domain when the HTTPRoute is not readable', () => {
    spawnSync.mockReturnValue(fail())

    extractPlatformOutputs(
      '/kubeconfig',
      writeConfig('domain: config.example\n')
    )

    expect(core.setOutput).toHaveBeenCalledWith('domain', 'config.example')
    expect(core.setOutput).toHaveBeenCalledWith(
      'keycloak-issuer-url',
      'https://keycloak.config.example'
    )
  })

  it('finds the gateway service by its owning-Gateway label, not namespace', () => {
    mockHealthyCluster()

    extractPlatformOutputs('/kubeconfig', writeConfig('domain: d\n'))

    expect(spawnSync).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining([
        '-A',
        '-l',
        'gateway.envoyproxy.io/owning-gateway-name=nebari-gateway'
      ]),
      expect.anything()
    )
  })

  it('falls back to the LoadBalancer hostname when there is no IP', () => {
    mockKubectl({
      'ingress[0].ip': () => ok(''),
      'ingress[0].hostname': () => ok('lb.example.com')
    })

    extractPlatformOutputs('/kubeconfig', writeConfig('domain: d\n'))

    expect(core.setOutput).toHaveBeenCalledWith('gateway-ip', 'lb.example.com')
  })

  it('degrades every output to empty instead of failing', () => {
    // Every kubectl call fails and the config has no domain: nothing to
    // extract anywhere, but the action must not fail.
    spawnSync.mockReturnValue(fail())

    extractPlatformOutputs('/kubeconfig', writeConfig('project_name: x\n'))

    for (const name of [
      'domain',
      'keycloak-issuer-url',
      'keycloak-admin-password',
      'keycloak-realm-admin-password',
      'argocd-admin-password',
      'gateway-ip'
    ]) {
      expect(core.setOutput).toHaveBeenCalledWith(name, '')
    }
    expect(core.setSecret).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })
})
