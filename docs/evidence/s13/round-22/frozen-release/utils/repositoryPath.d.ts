/** Resolve a repository-relative artifact without permitting lexical escapes. */
export declare function repositoryPath(root: string, relative: string): string;
/** Resolve an existing repository artifact and reject symlink escapes. */
export declare function existingRepositoryPath(root: string, relative: string): Promise<string>;
