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

  test('landing redirects with ?token, sets cookie, then renders the heading', async ({ page }) => {
    const token = readToken()
    await page.goto(`/?token=${token}`)
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'pglens' })).toBeVisible()
  })

  test('legacy /v3 path 301-redirects to root', async ({ page }) => {
    const token = readToken()
    // Prime the cookie so the auth middleware doesn't intercept with its own 302.
    await page.goto(`/?token=${token}`)
    const res = await page.goto('/v3/tables/foo')
    expect(res?.status()).toBe(200) // followed: 301 → 200
    await expect(page).toHaveURL('/tables/foo')
  })

  test('rejects an obviously wrong token without setting a cookie', async ({ page }) => {
    const res = await page.goto('/?token=bogus')
    expect(res?.status()).toBe(401)
  })
})
