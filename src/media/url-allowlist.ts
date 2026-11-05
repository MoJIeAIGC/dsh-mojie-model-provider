/**
 * Trusted image-URL allowlist for edit references.
 *
 * URLs returned by the plugin's own tasks are trusted automatically at runtime
 * (they were just produced for this Session). Hosts listed here are trusted
 * without probing, for deployments that know their image CDN; fill the list
 * with host suffixes (for example `example-cdn.com`) as needed.
 *
 * A trusted URL is passed to the provider unchanged. Everything else is
 * signature-stripped and probed before it may enter `input_image_urls`.
 *
 * @module @deepseek-ai/dsh-mojie-model-provider/media/url-allowlist
 */

/** Host suffixes trusted without probing. Fill as needed; empty by default. */
export const TRUSTED_IMAGE_URL_HOSTS: readonly string[] = [
  // 'example-cdn.com',
]

const returnedUrls = new Set<string>()

/** Remember one URL the provider returned for this process. */
export function rememberReturnedImageUrl(url: string): void {
  returnedUrls.add(url)
}

/**
 * Whether an image URL may skip signature stripping and probing.
 * @param url - the candidate URL.
 * @returns true for a URL this process produced, or a host on the allowlist.
 */
export function isTrustedImageUrl(url: string): boolean {
  if (returnedUrls.has(url)) return true
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return TRUSTED_IMAGE_URL_HOSTS.some((suffix) => {
    const normalized = suffix.trim().toLowerCase().replace(/^\.+/u, '')
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`))
  })
}
