// Superseded by CheckView.tsx (2026-08-20 — "Réconciliation" became "Check", 4 checks in one
// run instead of 1). Left as a harmless re-export instead of deleted: the sandbox this was
// authored in can't unlink files from git-tracked directories, so an empty/broken file here
// would otherwise permanently fail `tsc`. Nothing imports this anymore — page.tsx uses
// CheckView directly.
export { default } from './CheckView';
