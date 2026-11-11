declare module "diff-match-patch" {
  class diff_match_patch {
    diff_main(a: string, b: string, check?: boolean): [number, string][];
    diff_cleanupSemantic(diffs: [number, string][]): void;
    diff_cleanupEfficient(diffs: [number, string][]): void;
  }
}

