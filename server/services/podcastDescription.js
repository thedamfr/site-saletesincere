const PREVIEW_LENGTH = 200

export function getPodcastDescription(paragraphs, fallback = '') {
  const content = paragraphs?.length ? paragraphs : (fallback ? [fallback] : [])
  const text = content.join(' ')
  const expandable = text.length > PREVIEW_LENGTH
  let preview = text

  if (expandable) {
    const boundary = text.lastIndexOf(' ', PREVIEW_LENGTH)
    preview = text.slice(0, boundary > 0 ? boundary : PREVIEW_LENGTH).trimEnd()
  }

  return { preview, paragraphs: content, expandable }
}
