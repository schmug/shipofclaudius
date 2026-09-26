#!/usr/bin/env node
// Print, or write into a workflow, the inlined copy of this package (#262).
//
// Usage:
//   node packages/factory-gate/bin/inline.mjs                  # print the block to stdout
//   node packages/factory-gate/bin/inline.mjs --write <file>   # replace the block between the markers in <file>
//
// See ../src/inline.mjs for why the copy exists and what keeps it honest.

import { readFile, writeFile } from 'node:fs/promises'
import { renderInlineBlock, spliceInlineBlock } from '../src/inline.mjs'

async function main() {
  const argv = process.argv.slice(2)
  const block = await renderInlineBlock()
  const i = argv.indexOf('--write')
  if (i < 0) { process.stdout.write(block + '\n'); return }
  const file = argv[i + 1]
  if (!file) throw new Error('--write needs a file path')
  const before = await readFile(file, 'utf8')
  const after = spliceInlineBlock(before, block)
  if (after !== before) await writeFile(file, after)
  process.stdout.write(`${after === before ? 'unchanged' : 'updated'}: ${file}\n`)
}

main().catch((e) => {
  console.error(`factory-gate inline: ${e.message}`)
  process.exit(1)
})
