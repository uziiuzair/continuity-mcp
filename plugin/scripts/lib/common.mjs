import { isAbsolute, relative } from "node:path"

// Convert a file path to one relative to the git toplevel, so file_activity rows
// are comparable across machines with different checkout locations.
export function repoRelative(toplevel, filePath) {
  if (!filePath) return null
  if (isAbsolute(filePath)) {
    const rel = relative(toplevel, filePath)
    return rel.startsWith("..") ? filePath : rel
  }
  return filePath
}
