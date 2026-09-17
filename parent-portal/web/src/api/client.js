// Thin fetch wrapper over the gateway. Cookies (the JWT session) travel with
// every request via credentials: 'include'. Errors surface the service's
// `detail`/`error` message so the UI can show something meaningful.
const BASE = '/api'

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function request(path, { method = 'GET', body, headers } = {}) {
  // FormData (file uploads) must not be JSON-stringified, and must not get an
  // explicit Content-Type — the browser sets one itself with the multipart
  // boundary. Setting it manually here would omit the boundary and the
  // server would fail to parse the body at all.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const detail = (data && (data.detail || data.error || data.message)) || res.statusText
    throw new ApiError(typeof detail === 'string' ? detail : 'Request failed', res.status, data)
  }
  return data
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: body ?? {} }),
  patch: (p, body) => request(p, { method: 'PATCH', body: body ?? {} }),
  del: (p) => request(p, { method: 'DELETE' }),
  // File uploads: pass a FormData body straight through (see request()).
  upload: (p, formData) => request(p, { method: 'POST', body: formData }),

  // Auth (real Auth Service in prod; dev shim under `vite dev`). The real
  // Auth Service (services/auth/routes/auth.routes.js) has always required
  // {email, password} — a role alone 400s there. The dev shim historically
  // diverged (role-only), which is why the demo-picker buttons in
  // Login.jsx only ever worked under `vite dev`, never against a real
  // Docker stack; the shim (vite.config.js) is fixed to match this too.
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: ({ name, email, password, role, schoolId }) => request('/auth/register', {
    method: 'POST',
    body: { name, email, password, role, schoolId },
  }),
  me: () => request('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
}
