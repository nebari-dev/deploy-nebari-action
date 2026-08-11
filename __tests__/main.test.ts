/**
 * Unit tests for the action's main step, src/main.ts
 *
 * The nic module (binary acquisition, command execution, convergence wait)
 * is mocked so no real commands run; the tests exercise input handling,
 * state saved for the post step, and the outputs.
 */
import * as path from 'node:path'

import { jest } from '@jest/globals'

import * as core from '../__fixtures__/core.js'
import * as nic from '../__fixtures__/nic.js'

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/nic.js', () => nic)

// The module being tested should be imported dynamically. This ensures that
// the mocks are used in place of any actual dependencies.
const { run } = await import('../src/main.js')

const kubeconfig = path.join('/runner-tmp', 'nic-kubeconfig-deploy-step')

function setInputs(
  inputs: Record<string, string>,
  booleans: Record<string, boolean>
): void {
  core.getInput.mockImplementation((name) => inputs[name] ?? '')
  core.getBooleanInput.mockImplementation((name) => {
    if (name in booleans) return booleans[name]
    throw new Error(`unexpected getBooleanInput(${name})`)
  })
}

describe('main.ts', () => {
  beforeEach(() => {
    process.env.RUNNER_TEMP = '/runner-tmp'
    process.env.GITHUB_ACTION = 'deploy-step'

    setInputs(
      { 'nic-binary': 'nic', token: 'tok', 'wait-timeout': '600' },
      { wait: false, destroy: true, force: true }
    )
    nic.acquireNic.mockReturnValue('/tmp/nic')
  })

  afterEach(() => {
    delete process.env.RUNNER_TEMP
    delete process.env.GITHUB_ACTION
    jest.resetAllMocks()
  })

  it('deploys with the built-in default config when config is unset', () => {
    run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(nic.acquireNic).toHaveBeenCalledWith({
      binary: 'nic',
      version: '',
      token: 'tok'
    })
    expect(nic.run).toHaveBeenCalledWith('/tmp/nic', [
      'deploy',
      '-f',
      expect.stringMatching(/default-config\.yaml$/)
    ])
  })

  it('deploys the config passed via the config input', () => {
    setInputs(
      { config: 'my-config.yaml', 'nic-binary': 'nic' },
      { wait: false, destroy: true, force: true }
    )

    run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(nic.run).toHaveBeenCalledWith('/tmp/nic', [
      'deploy',
      '-f',
      path.resolve('my-config.yaml')
    ])
  })

  it('exports KUBECONFIG and sets the outputs', () => {
    run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(nic.run).toHaveBeenCalledWith('/tmp/nic', [
      'kubeconfig',
      '-f',
      expect.any(String),
      '-o',
      kubeconfig
    ])
    expect(core.exportVariable).toHaveBeenCalledWith('KUBECONFIG', kubeconfig)
    expect(core.setOutput).toHaveBeenCalledWith('kubeconfig', kubeconfig)
    expect(core.setOutput).toHaveBeenCalledWith('nic-binary', '/tmp/nic')
  })

  it('saves teardown state before running the deploy', () => {
    nic.run.mockImplementation((_cmd, args) => {
      if (args[0] === 'deploy') throw new Error('deploy blew up')
    })

    run()

    expect(core.setFailed).toHaveBeenCalledWith('deploy blew up')
    expect(core.saveState).toHaveBeenCalledWith('deployStarted', 'true')
    expect(core.saveState).toHaveBeenCalledWith('nicBinary', '/tmp/nic')
    expect(core.saveState).toHaveBeenCalledWith('destroy', 'true')
    expect(core.saveState).toHaveBeenCalledWith('force', 'true')
  })

  it('waits for Applications when wait is true', () => {
    setInputs(
      { 'nic-binary': 'nic', 'wait-timeout': '900' },
      { wait: true, destroy: true, force: true }
    )

    run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(nic.waitForApplications).toHaveBeenCalledWith(kubeconfig, 900)
  })

  it('skips the wait when wait is false', () => {
    run()

    expect(nic.waitForApplications).not.toHaveBeenCalled()
  })

  it('rejects a malformed wait-timeout before deploying', () => {
    setInputs(
      { 'nic-binary': 'nic', 'wait-timeout': '300s' },
      { wait: true, destroy: true, force: true }
    )

    run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringMatching(/wait-timeout must be a positive integer/)
    )
    // The validation must run before the deploy: a malformed wait-timeout
    // should cost seconds, not a completed cloud deploy.
    expect(nic.run).not.toHaveBeenCalledWith(
      '/tmp/nic',
      expect.arrayContaining(['deploy'])
    )
    expect(nic.waitForApplications).not.toHaveBeenCalled()
    // A deploy that never ran must leave nothing for the post step to
    // destroy.
    expect(core.saveState).not.toHaveBeenCalledWith('deployStarted', 'true')
  })

  it('does not mark deployStarted when the wait input is malformed', () => {
    core.getBooleanInput.mockImplementation((name) => {
      if (name === 'wait') throw new Error('wait is not a boolean')
      return true
    })

    run()

    expect(core.setFailed).toHaveBeenCalledWith('wait is not a boolean')
    expect(nic.run).not.toHaveBeenCalledWith(
      '/tmp/nic',
      expect.arrayContaining(['deploy'])
    )
    expect(core.saveState).not.toHaveBeenCalledWith('deployStarted', 'true')
  })
})
