/**
 * Unit tests for src/nic.ts
 *
 * child_process is mocked so no real commands run; the filesystem is real
 * (temp dirs) where creating a file is simpler than mocking fs. The sleep
 * between convergence polls is neutralized by stubbing Atomics.wait, so
 * multi-poll scenarios run instantly.
 */
import * as crypto from 'node:crypto'
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

const { run, capture, acquireNic, waitForApplications } =
  await import('../src/nic.js')

const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout, stderr: '' })
const fail = (stderr = '', status = 1): SpawnResult => ({
  status,
  stdout: '',
  stderr
})

let tmpDir: string

beforeAll(() => {
  // The convergence wait sleeps 10s between polls via Atomics.wait; stub it
  // so multi-poll tests run instantly.
  jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nic-test-'))
  process.env.RUNNER_TEMP = tmpDir
  spawnSync.mockReturnValue(ok())
})

afterEach(() => {
  delete process.env.RUNNER_TEMP
  fs.rmSync(tmpDir, { recursive: true, force: true })
  jest.clearAllMocks()
})

function writeExecutable(name: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, '#!/bin/sh\n')
  fs.chmodSync(p, 0o755)
  return p
}

describe('run', () => {
  it('runs the command and logs it', () => {
    run('echo', ['hi'])

    expect(spawnSync).toHaveBeenCalledWith(
      'echo',
      ['hi'],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(core.info).toHaveBeenCalledWith('$ echo hi')
  })

  it('throws when the command cannot be started', () => {
    spawnSync.mockReturnValue({ ...fail(), error: new Error('ENOENT') })

    expect(() => run('missing', [])).toThrow(/failed to start missing: ENOENT/)
  })

  it('throws on a non-zero exit status', () => {
    spawnSync.mockReturnValue(fail('', 2))

    expect(() => run('false', [])).toThrow(/false exited with status 2/)
  })
})

describe('capture', () => {
  it('returns stdout', () => {
    spawnSync.mockReturnValue(ok('output\n'))

    expect(capture('echo', ['output'])).toBe('output\n')
  })

  it('throws with stderr on failure', () => {
    spawnSync.mockReturnValue(fail('boom', 3))

    expect(() => capture('cmd', [])).toThrow(/cmd exited with status 3: boom/)
  })
})

describe('acquireNic', () => {
  it('rejects setting both nic-binary and nic-version', () => {
    expect(() =>
      acquireNic({ binary: 'nic', version: 'latest', token: '' })
    ).toThrow(/mutually exclusive/)
  })

  it('rejects setting neither nic-binary nor nic-version', () => {
    expect(() => acquireNic({ binary: '', version: '', token: '' })).toThrow(
      /no nic binary specified/
    )
  })

  it('registers the token for log masking', () => {
    const bin = writeExecutable('nic')

    acquireNic({ binary: bin, version: '', token: 'tok' })

    expect(core.setSecret).toHaveBeenCalledWith('tok')
  })

  describe('nic-binary', () => {
    it('returns the resolved path of an executable binary', () => {
      const bin = writeExecutable('nic')

      expect(acquireNic({ binary: bin, version: '', token: '' })).toBe(bin)
    })

    it('rejects a missing or non-executable binary', () => {
      expect(() =>
        acquireNic({
          binary: path.join(tmpDir, 'nope'),
          version: '',
          token: ''
        })
      ).toThrow(/missing or non-executable/)
    })
  })

  describe('release download', () => {
    const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch as string]
    const tarballFor = (version: string): string =>
      `nebari-infrastructure-core_${version}_${process.platform}_${arch}.tar.gz`
    const tarBytes = 'tarball-bytes'
    const tarSha = crypto.createHash('sha256').update(tarBytes).digest('hex')

    // Simulate the download pipeline: curl writes the tarball, serves
    // checksums.txt (one line per entry) and the latest-release API, gh
    // verifies, and tar extracts a nic binary into the destination.
    function mockChecksums(entries: Record<string, string>): void {
      const body = Object.entries(entries)
        .map(([name, sum]) => `${sum}  ${name}`)
        .join('\n')
      spawnSync.mockImplementation((cmd, args) => {
        if (cmd === 'curl') {
          const url = args.find((a) => a.startsWith('https://')) ?? ''
          if (url.includes('api.github.com')) {
            return ok(JSON.stringify({ tag_name: 'v0.11.0' }))
          }
          if (url.endsWith('checksums.txt')) return ok(`${body}\n`)
          const dest = args[args.indexOf('-o') + 1]
          fs.writeFileSync(dest, tarBytes)
          return ok()
        }
        if (cmd === 'tar') {
          const destDir = args[args.indexOf('-C') + 1]
          const bin = path.join(destDir, 'nic')
          fs.writeFileSync(bin, '#!/bin/sh\n')
          fs.chmodSync(bin, 0o755)
          return ok()
        }
        return ok()
      })
    }

    it('rejects platforms that have no release archive', () => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        expect(() =>
          acquireNic({ binary: '', version: 'v0.10.0', token: 'tok' })
        ).toThrow(/no release archive for platform 'win32'/)
      } finally {
        Object.defineProperty(
          process,
          'platform',
          original as PropertyDescriptor
        )
      }
    })

    it('refuses release tags older than v0.10.0', () => {
      expect(() =>
        acquireNic({ binary: '', version: 'v0.9.9', token: 'tok' })
      ).toThrow(/predates build-provenance attestations/)
      // Refused before any download happens.
      expect(spawnSync).not.toHaveBeenCalled()
    })

    it('downloads, verifies provenance and checksum, and extracts', () => {
      mockChecksums({ [tarballFor('0.10.0')]: tarSha })

      const bin = acquireNic({ binary: '', version: 'v0.10.0', token: 'tok' })

      expect(bin).toBe(path.join(tmpDir, 'nic-bin', 'nic'))
      expect(spawnSync).toHaveBeenCalledWith(
        'gh',
        [
          'attestation',
          'verify',
          expect.stringContaining(tarballFor('0.10.0')),
          '--repo',
          'nebari-dev/nebari-infrastructure-core',
          '--signer-workflow',
          'nebari-dev/nebari-infrastructure-core/.github/workflows/release.yml'
        ],
        expect.objectContaining({
          env: expect.objectContaining({ GH_TOKEN: 'tok' })
        })
      )
    })

    it("resolves 'latest' to the newest release tag", () => {
      mockChecksums({ [tarballFor('0.11.0')]: tarSha })

      const bin = acquireNic({ binary: '', version: 'latest', token: 'tok' })

      expect(bin).toBe(path.join(tmpDir, 'nic-bin', 'nic'))
      expect(core.info).toHaveBeenCalledWith("Resolved 'latest' -> v0.11.0")
      expect(spawnSync).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining([
          expect.stringContaining('/releases/download/v0.11.0/')
        ]),
        expect.anything()
      )
    })

    it('rejects a tampered tarball on checksum mismatch', () => {
      mockChecksums({ [tarballFor('0.10.0')]: 'deadbeef' })

      expect(() =>
        acquireNic({ binary: '', version: 'v0.10.0', token: 'tok' })
      ).toThrow(/checksum mismatch/)
    })

    it('rejects a tarball missing from checksums.txt', () => {
      mockChecksums({ 'some-other-file.tar.gz': tarSha })

      expect(() =>
        acquireNic({ binary: '', version: 'v0.10.0', token: 'tok' })
      ).toThrow(/checksum mismatch/)
    })

    it('surfaces provenance verification failures with guidance', () => {
      spawnSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh') return fail('attestation not found')
        if (cmd === 'curl') {
          const dest = args[args.indexOf('-o') + 1]
          fs.writeFileSync(dest, tarBytes)
          return ok()
        }
        return ok()
      })

      expect(() =>
        acquireNic({ binary: '', version: 'v0.10.0', token: 'tok' })
      ).toThrow(/build provenance verification failed/)
    })
  })

  describe('source build', () => {
    it('requires Go for a git ref', () => {
      spawnSync.mockImplementation((cmd) => (cmd === 'go' ? fail() : ok()))

      expect(() =>
        acquireNic({ binary: '', version: 'main', token: '' })
      ).toThrow(/Go is not installed/)
    })

    it('fetches the ref and builds with CGO disabled', () => {
      const bin = acquireNic({ binary: '', version: 'my-branch', token: '' })

      expect(bin).toBe(path.join(tmpDir, 'nic-bin', 'nic'))
      expect(spawnSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          'fetch',
          '--depth',
          '1',
          'origin',
          'my-branch'
        ]),
        expect.anything()
      )
      expect(spawnSync).toHaveBeenCalledWith(
        'go',
        ['build', '-trimpath', '-o', bin, './cmd/nic'],
        expect.objectContaining({
          env: expect.objectContaining({ CGO_ENABLED: '0' })
        })
      )
    })
  })
})

describe('waitForApplications', () => {
  interface PodSpec {
    namespace: string
    name: string
    uid?: string
    restarts?: number
    crashLooping?: boolean
    phase?: string
    jobOwned?: boolean
  }

  function podsJson(pods: PodSpec[]): string {
    return JSON.stringify({
      items: pods.map((p) => ({
        metadata: {
          namespace: p.namespace,
          name: p.name,
          uid: p.uid ?? `uid-${p.name}`,
          ownerReferences: p.jobOwned ? [{ kind: 'Job' }] : []
        },
        status: {
          phase: p.phase ?? 'Running',
          containerStatuses: [
            {
              name: 'main',
              restartCount: p.restarts ?? 0,
              state: p.crashLooping
                ? { waiting: { reason: 'CrashLoopBackOff' } }
                : {}
            }
          ]
        }
      }))
    })
  }

  const healthy = [
    'nebari-root Synced Healthy argocd',
    'keycloak Synced Healthy keycloak'
  ].join('\n')
  const progressing = [
    'nebari-root OutOfSync Progressing argocd',
    'keycloak OutOfSync Progressing keycloak'
  ].join('\n')

  // Serve app and pod poll responses from queues; the last entry repeats so
  // tests only spell out the polls that differ. Diagnostics and log dumps
  // succeed silently.
  function mockPolls(appPolls: SpawnResult[], podPolls: string[]): void {
    const apps = [...appPolls]
    const pods = [...podPolls]
    const next = <T>(q: T[]): T => (q.length > 1 ? (q.shift() ?? q[0]) : q[0])
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd !== 'kubectl') return ok()
      if (args.includes('applications.argoproj.io') && !args.includes('wide')) {
        return next(apps)
      }
      if (args.includes('pods') && args.includes('json')) {
        return ok(next(pods))
      }
      return ok()
    })
  }

  it('returns once converged and stable for three polls', () => {
    mockPolls([ok(healthy)], [podsJson([])])

    waitForApplications('kubeconfig', 600)

    expect(core.info).toHaveBeenCalledWith(
      'All 2 Applications are Healthy and nebari-root is Synced'
    )
    expect(core.warning).not.toHaveBeenCalled()
    // Two sleeps between the three stable polls.
    expect(Atomics.wait).toHaveBeenCalledTimes(2)
  })

  it('does not converge on Healthy apps while nebari-root is OutOfSync', () => {
    mockPolls(
      [
        ok(
          [
            'nebari-root OutOfSync Healthy argocd',
            'keycloak Synced Healthy keycloak'
          ].join('\n')
        )
      ],
      [podsJson([])]
    )

    expect(() => waitForApplications('kubeconfig', 0)).toThrow(
      /did not converge within 0s/
    )
    expect(core.info).toHaveBeenCalledWith(
      'nebari-root: sync=OutOfSync (must be Synced)'
    )
  })

  it('times out when no Applications appear', () => {
    mockPolls([ok('')], [podsJson([])])

    expect(() => waitForApplications('kubeconfig', 0)).toThrow(
      /did not converge within 0s/
    )
    expect(core.info).toHaveBeenCalledWith('<no Applications found>')
  })

  it('warns about Applications that are Healthy but not Synced', () => {
    mockPolls(
      [
        ok(
          [
            'nebari-root Synced Healthy argocd',
            'keycloak OutOfSync Healthy keycloak'
          ].join('\n')
        )
      ],
      [podsJson([])]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Healthy but not Synced: keycloak \(OutOfSync\)/)
    )
  })

  it('fails fast on a container crashlooping past its restart budget', () => {
    const pod = { namespace: 'argocd', name: 'repo-server' }
    mockPolls(
      [ok(progressing)],
      [
        podsJson([{ ...pod, restarts: 0 }]),
        podsJson([{ ...pod, restarts: 4, crashLooping: true }])
      ]
    )

    expect(() => waitForApplications('kubeconfig', 600)).toThrow(
      /argocd\/repo-server\/main is in CrashLoopBackOff after 4 restarts/
    )
    // The previous logs of the breaching container are dumped.
    expect(spawnSync).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['logs', '--previous', '-c', 'main']),
      expect.anything()
    )
  })

  it('ignores restarts that predate the wait', () => {
    // 10 lifetime restarts on the first poll set the baseline; the count
    // never grows during the wait, so there is no breach and no warning.
    mockPolls(
      [ok(healthy)],
      [
        podsJson([
          {
            namespace: 'argocd',
            name: 'repo-server',
            restarts: 10,
            crashLooping: true
          }
        ])
      ]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).not.toHaveBeenCalled()
  })

  it('only warns when a flapper stays within budget and convergence succeeds', () => {
    const pod = { namespace: 'argocd', name: 'repo-server' }
    mockPolls(
      [ok(progressing), ok(healthy)],
      [podsJson([{ ...pod, restarts: 0 }]), podsJson([{ ...pod, restarts: 2 }])]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /restarted during the wait but the deployment converged: argocd\/repo-server\/main \(2\)/
      )
    )
  })

  it('reports a mid-wait flap even when the pod is gone by convergence', () => {
    // The container restarts twice mid-wait, then its pod disappears from
    // later polls (replaced, deleted, or garbage-collected). The success
    // warning must reflect the whole wait, not just the final poll.
    const pod = { namespace: 'argocd', name: 'repo-server' }
    mockPolls(
      [ok(progressing), ok(healthy)],
      [
        podsJson([{ ...pod, restarts: 0 }]),
        podsJson([{ ...pod, restarts: 2 }]),
        podsJson([])
      ]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /restarted during the wait but the deployment converged: argocd\/repo-server\/main \(2\)/
      )
    )
  })

  it('counts restarts of a pod replaced under the same name', () => {
    // The baseline pod has 4 lifetime restarts, then is replaced under the
    // same name (StatefulSet recreation). The replacement's counter starts
    // over, so its 4 restarts all happened during the wait; with a
    // name-keyed baseline they would hide under the dead pod's count.
    const pod = { namespace: 'argocd', name: 'repo-server' }
    mockPolls(
      [ok(progressing)],
      [
        podsJson([{ ...pod, uid: 'old', restarts: 4 }]),
        podsJson([{ ...pod, uid: 'new', restarts: 4, crashLooping: true }])
      ]
    )

    expect(() => waitForApplications('kubeconfig', 600)).toThrow(
      /argocd\/repo-server\/main is in CrashLoopBackOff after 4 restarts/
    )
  })

  it('respects per-namespace restart budget overrides', () => {
    // keycloak's budget is 5: four restarts during the wait, even while
    // crashlooping, must not fail the wait.
    const pod = { namespace: 'keycloak', name: 'keycloak-0' }
    mockPolls(
      [ok(progressing), ok(healthy)],
      [
        podsJson([{ ...pod, restarts: 0 }]),
        podsJson([{ ...pod, restarts: 4, crashLooping: true }])
      ]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/keycloak\/keycloak-0\/main \(4\)/)
    )
  })

  it('ignores Job-owned and completed pods', () => {
    mockPolls(
      [ok(healthy)],
      [
        podsJson([
          {
            namespace: 'argocd',
            name: 'hook',
            restarts: 100,
            crashLooping: true,
            jobOwned: true
          },
          {
            namespace: 'argocd',
            name: 'done',
            restarts: 100,
            phase: 'Succeeded'
          }
        ]),
        podsJson([
          {
            namespace: 'argocd',
            name: 'hook',
            restarts: 200,
            crashLooping: true,
            jobOwned: true
          },
          {
            namespace: 'argocd',
            name: 'done',
            restarts: 200,
            phase: 'Succeeded'
          }
        ])
      ]
    )

    waitForApplications('kubeconfig', 600)

    expect(core.warning).not.toHaveBeenCalled()
  })

  it('tolerates malformed pod listings without failing the wait', () => {
    mockPolls([ok(healthy)], ['not json'])

    waitForApplications('kubeconfig', 600)

    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns once on kubectl poll failures and keeps retrying', () => {
    mockPolls([fail('connection refused'), ok(healthy)], [podsJson([])])

    waitForApplications('kubeconfig', 600)

    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /kubectl get applications failed: connection refused/
      )
    )
  })
})
