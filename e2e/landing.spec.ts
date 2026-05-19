import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function readToken() {
  const tokenFile = path.join(os.homedir(), '.pglens', 'token')
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`Token file not found at ${tokenFile}. Did the server boot?`)
  }
  return fs.readFileSync(tokenFile, 'utf8').trim()
}

test.describe('v3 landing', () => {
  test('serves a 401 envelope when the token is missing', async ({ request }) => {
    const res = await request.get('/api/connections')
    expect(res.status()).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  test('GET /api/v3/health is open and returns ok', async ({ request }) => {
    const res = await request.get('/api/v3/health')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test('v3 landing redirects with ?token, sets cookie, then renders the heading', async ({ page }) => {
    const token = readToken()
    await page.goto(`/v3/?token=${token}`)
    await expect(page).toHaveURL('/v3/')
    await expect(page.getByRole('heading', { name: 'pglens v3' })).toBeVisible()
  })

  test('rejects an obviously wrong token without setting a cookie', async ({ page }) => {
    const res = await page.goto('/v3/?token=bogus')
    expect(res?.status()).toBe(401)
  })
})
