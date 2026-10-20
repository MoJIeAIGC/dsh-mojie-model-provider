import { describe, expect, it } from 'vitest'
import { Config, PROVIDER_ROUTES, apply, createAdapter, inject, name } from '../src/index.ts'

describe('dsh-mojie-model-provider facade', () => {
  it('is a function plugin with loader metadata', () => {
    expect(name).toBe('dsh-mojie-model-provider')
    expect(inject).toContain('llm')
    expect(typeof apply).toBe('function')
  })

  it('validates config and applies the deployment defaults', () => {
    const config = Config({ apiKey: 'test-key' })
    expect(config.baseURL).toBe('https://mojieaigc.com/v1')
    expect(config.models).toEqual([])
    expect(config.requestTimeoutMs).toBe(120_000)
  })

  it('claims exactly one provider route', () => {
    expect(PROVIDER_ROUTES).toEqual(['mojie'])
  })

  it('leaves the adapter unimplemented in the skeleton', () => {
    expect(createAdapter(Config({ apiKey: 'test-key' }))).toBeUndefined()
  })
})
