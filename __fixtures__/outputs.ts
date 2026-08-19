import type * as outputs from '../src/outputs.js'
import { jest } from '@jest/globals'

export const extractPlatformOutputs =
  jest.fn<typeof outputs.extractPlatformOutputs>()
export const parseDomain = jest.fn<typeof outputs.parseDomain>()
