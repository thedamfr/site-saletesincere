/** Backend-only Brevo adapter. Never log payloads, contact URLs or responses. */
export function createBrevoClient({
  baseUrl = process.env.BREVO_BASEURL || 'https://api.brevo.com/v3',
  apiKey = process.env.BREVO_API_KEY,
  listId = Number(process.env.BREVO_TEMP_LIST_ID || process.env.BREVO_LIST_ID),
  finalListId = Number(process.env.BREVO_FINAL_LIST_ID || process.env.BREVO_LIST_ID),
  fetchFn = fetch
} = {}) {
  function checkConfig() {
    return { valid: Boolean(apiKey) && Number.isSafeInteger(listId) && listId > 0 && Number.isSafeInteger(finalListId) && finalListId > 0 }
  }

  async function call(endpoint, { method = 'GET', body, signal } = {}) {
    if (!checkConfig().valid) return { unavailable: true, code: 'configuration_unavailable' }
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
        method,
        signal: signal || AbortSignal.timeout(10_000),
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
      let data = null
      if (response.status !== 204) {
        try { data = await response.json() } catch { /* Reconcile mutations with unreadable responses. */ }
      }
      return { status: response.status, ok: response.ok, data }
    } catch {
      return { unavailable: true, code: signal?.aborted ? 'request_timeout' : 'network_error' }
    }
  }

  async function lookup(email, { signal } = {}) {
    const result = await call(`/contacts/${encodeURIComponent(email)}`, { signal })
    if (result.status === 404) return { kind: 'not_found' }
    if (result.ok && Array.isArray(result.data?.listIds) && typeof result.data.emailBlacklisted === 'boolean') {
      return {
        kind: 'found',
        inTempList: result.data.listIds.includes(listId),
        inFinalList: Number.isSafeInteger(finalListId) && result.data.listIds.includes(finalListId),
        blocked: result.data.emailBlacklisted
      }
    }
    return { kind: 'unavailable', code: result.code || 'contact_lookup_failed' }
  }

  function mutationResult(result) {
    if (result.unavailable) return { kind: 'uncertain', code: result.code }
    if (result.status === 400 && result.data?.code === 'duplicate_parameter') return { kind: 'duplicate', code: 'contact_exists' }
    if (result.status === 429) return { kind: 'deferred', code: 'remote_rate_limited' }
    if ([401, 403, 404].includes(result.status)) return { kind: 'deferred', code: `remote_${result.status}` }
    if ([400, 422].includes(result.status)) return { kind: 'rejected', code: `remote_${result.status}` }
    return { kind: 'uncertain', code: 'remote_result_unknown' }
  }

  async function create(email, { signal } = {}) {
    const result = await call('/contacts', {
      method: 'POST', signal,
      body: { email, listIds: [listId], attributes: { SOURCE: 'Salewall', SUBSCRIPTION_DATE: new Date().toISOString() } }
    })
    if (result.status === 201) return { kind: 'submitted' }
    return mutationResult(result)
  }

  async function addToList(email, { signal } = {}) {
    const result = await call(`/contacts/lists/${listId}/contacts/add`, { method: 'POST', signal, body: { emails: [email] } })
    const details = result.data?.contacts || result.data
    const failures = details?.failure || result.data?.failure || []
    const successes = details?.success || result.data?.success || []
    if (result.ok && Array.isArray(successes) && successes.includes(email) && Array.isArray(failures) && !failures.includes(email)) {
      return { kind: 'submitted' }
    }
    return mutationResult(result)
  }

  return { listId, checkConfig, lookup, create, addToList }
}

export function checkConfig() {
  return createBrevoClient().checkConfig()
}
