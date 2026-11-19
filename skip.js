// One list of folders that are too big or too dull to walk into, shared by search indexing
// (backend.js) and the hunt for git repositories (git.js), so the two can never disagree.
// These folders still show up in the browser and can be opened; they are just not crawled.
const HEAVY_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache',
  'build', 'out', 'dist', 'sysroot', 'sysroots', '.pio', '.cache', 'managed_components',
  '.folder-map', '.folder-map-trash', 'System Volume Information', '$RECYCLE.BIN',
]);
module.exports = { HEAVY_DIRS };
