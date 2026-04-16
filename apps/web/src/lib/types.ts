export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
  sha: string;
};

export type TreeNode = WorkspaceEntry & {
  children: TreeNode[];
  isOpen: boolean;
  isLoaded: boolean;
  isLoading: boolean;
};

export type WorkspaceFile = {
  name: string;
  path: string;
  sha: string;
  size: number;
  encoding: string;
  content: string;
};

export type Workspace = {
  id: string;
  name: string;
  description: string;
};


