/**
 * llm-auth.js — The Authorization header for LLM requests (#420).
 *
 * A browser sends one Authorization header per request, and a header the page
 * sets replaces the credentials it saved for HTTP basic auth. A deployment
 * behind nginx `auth_basic` that proxies /api/llm/ and injects the real key
 * must therefore leave `api_key` unset, and we then send no header at all.
 */

/**
 * @param {string} [apiKey]
 * @returns {Object} `{ Authorization: 'Bearer <key>' }`, or `{}` when the key is
 *   absent or blank.
 */
export function bearerHeader(apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    return key ? { Authorization: `Bearer ${key}` } : {};
}
