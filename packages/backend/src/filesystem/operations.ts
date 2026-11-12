/** Provider-independent file operations; paths in results are projected by the session. */
export type FilesystemEntry = {
  name: string;
  path: string;
  kind: string;
  size: number;
  mtimeMs: number;
};
export type FilesystemInputs = {
  listDir: { limit?: number; cursor?: string };
  glob: { pattern: string; limit?: number };
  grep: {
    pattern: string;
    literal?: boolean;
    caseSensitive?: boolean;
    include?: string;
    context?: number;
    limit?: number;
  };
  mkdir: { recursive?: boolean };
  remove: { recursive?: boolean };
};
export type FilesystemResults = {
  listDir: { entries: FilesystemEntry[]; nextCursor?: string };
  glob: { paths: string[]; truncated: boolean };
  grep: {
    matches: { path: string; line: number; text: string; before: string[]; after: string[] }[];
    truncated: boolean;
  };
  mkdir: null;
  remove: null;
};
export type FilesystemMethod = keyof FilesystemInputs;
export type FilesystemResult = FilesystemResults[FilesystemMethod];
