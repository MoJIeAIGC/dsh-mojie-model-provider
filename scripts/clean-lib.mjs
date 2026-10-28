/**
 * Remove the compiled output before a build.
 *
 * `tsc` never deletes output for a source file that disappeared, so without this
 * a removed module would keep shipping in `lib/` (and in the packed tarball).
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
