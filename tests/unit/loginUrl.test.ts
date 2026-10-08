import { describe, expect, it } from 'vitest'
import { buildLoginUrl, readLoginResult } from '@/features/auth/loginUrl'

describe('buildLoginUrl', () => {
  it('携带当前页面作为 return_to，并去掉旧的登录结果参数', () => {
    const url = buildLoginUrl('https://api.example.com/', 'github', { pathname: '/trips', search: '?a=1&login_error=failed', hash: '#x' })
    expect(url).toBe('https://api.example.com/auth/oauth/github/start?return_to=%2Ftrips%3Fa%3D1%23x')
  })
  it('根路径', () => {
    expect(buildLoginUrl('http://localhost:8080', 'google', { pathname: '/', search: '', hash: '' })).toBe(
      'http://localhost:8080/auth/oauth/google/start?return_to=%2F',
    )
  })
})

describe('readLoginResult', () => {
  it('没有参数时不处理', () => {
    expect(readLoginResult('https://app.example.com/trips?a=1')).toEqual({ result: null, cleanedUrl: null })
  })
  it('登录成功', () => {
    expect(readLoginResult('https://app.example.com/trips?a=1&login=success#m')).toEqual({ result: { kind: 'success' }, cleanedUrl: '/trips?a=1#m' })
  })
  it('登录错误映射为中文提示，未知错误码使用通用提示', () => {
    expect(readLoginResult('https://app.example.com/?login_error=cancelled').result).toEqual({ kind: 'error', message: '已取消登录' })
    expect(readLoginResult('https://app.example.com/?login_error=whatever').result).toEqual({ kind: 'error', message: '登录失败，请稍后重试' })
    expect(readLoginResult('https://app.example.com/?login_error=cancelled').cleanedUrl).toBe('/')
  })
})
