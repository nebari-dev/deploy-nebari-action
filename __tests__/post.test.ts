/**
 * Unit tests for the action's post step, src/post.ts
 */
import { jest } from '@jest/globals'

import * as core from '../__fixtures__/core.js'
import * as nic from '../__fixtures__/nic.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/nic.js', () => nic)

const { run } = await import('../src/post.js')

function setState(state: Record<string, string>): void {
  core.getState.mockImplementation((name) => state[name] ?? '')
}

describe('post.ts', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('does nothing when the deploy never started', () => {
    setState({})

    run()

    expect(core.info).toHaveBeenCalledWith(
      'Deploy never started; nothing to destroy.'
    )
    expect(nic.run).not.toHaveBeenCalled()
  })

  it('leaves the deployment running when destroy is false', () => {
    setState({ deployStarted: 'true', destroy: 'false' })

    run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/leaving the deployment running/)
    )
    expect(nic.run).not.toHaveBeenCalled()
  })

  it('destroys with --force when force is true', () => {
    setState({
      deployStarted: 'true',
      destroy: 'true',
      force: 'true',
      nicBinary: '/tmp/nic',
      config: '/cfg/config.yaml'
    })

    run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(nic.run).toHaveBeenCalledWith('/tmp/nic', [
      'destroy',
      '-f',
      '/cfg/config.yaml',
      '--auto-approve',
      '--force'
    ])
  })

  it('destroys without --force when force is false', () => {
    setState({
      deployStarted: 'true',
      destroy: 'true',
      force: 'false',
      nicBinary: '/tmp/nic',
      config: '/cfg/config.yaml'
    })

    run()

    expect(nic.run).toHaveBeenCalledWith('/tmp/nic', [
      'destroy',
      '-f',
      '/cfg/config.yaml',
      '--auto-approve'
    ])
  })

  it('fails the step when the destroy fails', () => {
    setState({
      deployStarted: 'true',
      destroy: 'true',
      force: 'true',
      nicBinary: '/tmp/nic',
      config: '/cfg/config.yaml'
    })
    nic.run.mockImplementation(() => {
      throw new Error('destroy blew up')
    })

    run()

    expect(core.setFailed).toHaveBeenCalledWith('destroy blew up')
    // endGroup must run even when the destroy fails, so the failure output
    // does not render inside a collapsed group.
    expect(core.endGroup).toHaveBeenCalled()
  })
})
