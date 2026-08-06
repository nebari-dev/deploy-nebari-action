import type * as nic from '../src/nic.js'
import { jest } from '@jest/globals'

export const acquireNic = jest.fn<typeof nic.acquireNic>()
export const run = jest.fn<typeof nic.run>()
export const capture = jest.fn<typeof nic.capture>()
export const waitForApplications = jest.fn<typeof nic.waitForApplications>()
