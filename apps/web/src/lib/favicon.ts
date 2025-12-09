/**
 * Favicon utilities for fetching and displaying website icons
 */

/**
 * Extract domain from a URL
 */
export function getDomainFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    return urlObj.hostname;
  } catch {
    return null;
  }
}

/**
 * Get favicon URL for a given website URL
 * Uses Google's favicon service as fallback for reliability
 */
export function getFaviconUrl(url: string, size: 16 | 32 | 64 | 128 = 32): string | null {
  const domain = getDomainFromUrl(url);
  if (!domain) return null;
  
  // Use Google's favicon service - it's reliable and handles most cases
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
