/**
 * Trigger a browser file download. Accepts a ready Blob or a string (wrapped in
 * a Blob with the given mime). One place for the create-anchor-click-revoke
 * dance every export path needs.
 */
export function downloadBlob(
  content: string | Blob,
  fileName: string,
  mime = 'application/octet-stream',
) {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
