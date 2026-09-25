import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileAuthorContent } from '../../scripts/lib/author-content.mjs'

const source = '# Damien Cavaillès\n\nAuteur et journaliste tech.\n\nUne bio avec [un lien](/podcast).\n\n## Publications\n\n- Un article\n'
test('Markdown builds the name, role, intro and editable sections', () => {
  const page = compileAuthorContent(source)
  assert.equal(page.name, 'Damien Cavaillès')
  assert.equal(page.role, 'Auteur et journaliste tech.')
  assert.match(page.introHtml, /href="\/podcast"/)
  assert.equal(page.sections[0].title, 'Publications')
  assert.match(page.sections[0].html, /<li>Un article<\/li>/)
})
test('invalid editorial structure fails at build time', () => {
  for (const md of ['', 'No heading', '# Name\n\n## Empty', `${source}\n# Second name`]) {
    assert.throws(() => compileAuthorContent(md))
  }
})
test('raw HTML and unsafe links cannot become executable HTML', () => {
  const page = compileAuthorContent(source + '\n<script>alert(1)</script>\n\n[click](javascript:alert(1))\n')
  assert.doesNotMatch(page.sections[0].html, /<script|href="javascript:/)
  assert.match(page.sections[0].html, /&lt;script&gt;/)
})
