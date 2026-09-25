import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { compileAuthorContent } from './lib/author-content.mjs'

const page = compileAuthorContent(await readFile(new URL('../content/damien-cavailles.md', import.meta.url), 'utf8'))
const output = new URL('../server/generated/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('author.json', output), `${JSON.stringify(page, null, 2)}\n`)
console.log(`Author content built: ${page.sections.length} sections`)
