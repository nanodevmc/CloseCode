import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import type { ProviderView, SettingsView } from '../shared/types'
import { getSettingsView, saveSettings, setActiveModel } from './settings'

export interface UnlockerStatus {
  alive: boolean
  port: number
  enabled: boolean
  googleAccount: {
    email: string | null
    hasToken: boolean
    authMethod: string | null
  } | null
}

const DEFAULT_UNLOCKER_PORT = 53129
let unlockerEnabled = true

function getLocalAgyCreds(): { clientId: string; clientSecret: string } | null {
  try {
    const home = os.homedir()
    const agyBin = path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
    if (fs.existsSync(agyBin)) {
      const data = fs.readFileSync(agyBin, 'latin1')
      const idMatch = data.match(/[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com/)
      const secMatch = data.match(/GOCSPX-[a-zA-Z0-9_\-]+/)
      if (idMatch && secMatch) {
        return {
          clientId: idMatch[0],
          clientSecret: secMatch[0].replace(/(decoding|field|https)$/, '')
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

export function isUnlockerEnabled(): boolean {
  return unlockerEnabled
}

export function applyUnlockerProxy(): void {
  const proxyUrl = `http://127.0.0.1:${DEFAULT_UNLOCKER_PORT}`
  if (unlockerEnabled) {
    try {
      setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }))
    } catch {
      // ignore
    }
    process.env.HTTPS_PROXY = proxyUrl
    process.env.HTTP_PROXY = proxyUrl
    process.env.ALL_PROXY = proxyUrl
    process.env.AG_LS_PROXY = proxyUrl
    process.env.NO_PROXY = 'localhost,127.0.0.1'
  } else {
    try {
      setGlobalDispatcher(new Agent())
    } catch {
      // ignore
    }
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    delete process.env.ALL_PROXY
    delete process.env.AG_LS_PROXY
  }
}

export function setUnlockerEnabled(enabled: boolean): void {
  unlockerEnabled = enabled
  applyUnlockerProxy()
}

export async function checkUnlockerAlive(port = DEFAULT_UNLOCKER_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout: 1500
      },
      (res) => {
        resolve(res.statusCode !== undefined)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

export async function refreshGoogleSessionIfNeeded(): Promise<string | null> {
  try {
    const creds = getLocalAgyCreds()
    if (!creds) return null

    const home = os.homedir()
    const tokenFile = path.join(home, '.gemini', 'jetski-standalone-oauth-token')
    if (!fs.existsSync(tokenFile)) return null

    const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as Record<string, unknown>
    const tokObj = (parsed.token && typeof parsed.token === 'object' ? parsed.token : {}) as Record<string, unknown>
    const refreshToken = (tokObj.refresh_token as string) || null
    if (!refreshToken) return null

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })

    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>
      if (typeof data.access_token === 'string') {
        tokObj.access_token = data.access_token
        parsed.token = tokObj
        fs.writeFileSync(tokenFile, JSON.stringify(parsed, null, 2), 'utf-8')
        return data.access_token
      }
    }
  } catch {
    // ignore
  }
  return null
}

export function getAntigravityGoogleSession(): {
  token: string
  email: string | null
  authMethod: string | null
} | null {
  try {
    const home = os.homedir()
    const tokenFile = path.join(home, '.gemini', 'jetski-standalone-oauth-token')
    if (fs.existsSync(tokenFile)) {
      const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as Record<string, unknown>
      let tokStr: string | null = null
      if (parsed?.token && typeof parsed.token === 'object') {
        const obj = parsed.token as Record<string, unknown>
        if (typeof obj.access_token === 'string') {
          tokStr = obj.access_token
        }
      } else if (typeof parsed?.token === 'string') {
        tokStr = parsed.token
      }
      if (tokStr) {
        return {
          token: tokStr,
          email: parsed.id_token_email ? String(parsed.id_token_email) : null,
          authMethod: parsed.auth_method ? String(parsed.auth_method) : 'consumer'
        }
      }
    }
    const credsFile = path.join(home, '.gemini', 'oauth_creds.json')
    if (fs.existsSync(credsFile)) {
      const parsed = JSON.parse(fs.readFileSync(credsFile, 'utf-8')) as Record<string, unknown>
      if (typeof parsed?.access_token === 'string') {
        return {
          token: parsed.access_token,
          email: null,
          authMethod: 'oauth'
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

export async function getUnlockerStatus(): Promise<UnlockerStatus> {
  const alive = await checkUnlockerAlive()
  const google = getAntigravityGoogleSession()
  return {
    alive,
    port: DEFAULT_UNLOCKER_PORT,
    enabled: unlockerEnabled,
    googleAccount: google
      ? {
          email: google.email,
          hasToken: Boolean(google.token),
          authMethod: google.authMethod
        }
      : null
  }
}

export async function importGoogleAntigravityProvider(): Promise<SettingsView> {
  await refreshGoogleSessionIfNeeded()
  const session = getAntigravityGoogleSession()
  if (!session?.token) {
    throw new Error('Google OAuth сессия Antigravity не найдена в ~/.gemini')
  }

  const settings = getSettingsView()
  const providerId = 'google-antigravity'
  const label = session.email ? `Google (${session.email})` : 'Google (Antigravity Pro/Ultra)'
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash'
  ]

  const existingIndex = settings.providers.findIndex((p: ProviderView) => p.id === providerId)
  const drafts = settings.providers.map((p: ProviderView) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    models: p.models,
    apiKey: undefined as string | undefined
  }))

  if (existingIndex >= 0) {
    drafts[existingIndex].label = label
    drafts[existingIndex].models = models
    drafts[existingIndex].apiKey = session.token
  } else {
    drafts.unshift({
      id: providerId,
      label,
      kind: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models,
      apiKey: session.token
    })
  }

  saveSettings({
    providers: drafts,
    activeProviderId: providerId,
    activeModel: models[0]
  })

  return setActiveModel(providerId, models[0])
}
