import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: false })
const inlineText = token => (token?.children || []).map(child => child.type === 'text' || child.type === 'code_inline' ? child.content : '').join('').trim()

export function compileAuthorContent(source) {
  const tokens = md.parse(source, {})
  const headings = tokens.filter(token => token.type === 'heading_open' && token.tag === 'h1')
  if (headings.length !== 1 || tokens[0]?.tag !== 'h1' || tokens[0]?.type !== 'heading_open') {
    throw new Error('Author Markdown must start with exactly one H1')
  }
  const name = inlineText(tokens[1])
  if (!name || tokens[3]?.type !== 'paragraph_open' || !inlineText(tokens[4])) {
    throw new Error('Author Markdown needs a name and introductory role paragraph')
  }
  const role = inlineText(tokens[4])
  const sections = []
  let start = 6
  let title = null
  let introHtml = ''
  for (let index = 6; index <= tokens.length; index++) {
    if (index !== tokens.length && !(tokens[index].type === 'heading_open' && tokens[index].tag === 'h2')) continue
    const html = md.renderer.render(tokens.slice(start, index), md.options, {})
    if (title === null) introHtml = html
    else sections.push({ title, html })
    if (index < tokens.length) {
      title = inlineText(tokens[index + 1])
      start = index + 3
    }
  }
  if (!introHtml.trim() || !sections.length || sections.some(section => !section.title || !section.html.trim())) {
    throw new Error('Author Markdown needs a biography and non-empty H2 sections')
  }
  return { name, role, title: `${name} — ${role.replace(/\.$/, '')} | Saleté Sincère`,
    description: `${name}, ${role.charAt(0).toLowerCase()}${role.slice(1)} Biographie, publications, travail d’éditeur et webinars.`,
    introHtml, sections }
}
