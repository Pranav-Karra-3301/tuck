import simpleGit from 'simple-git';

/** Whether a usable `git` binary is on PATH (gates commit-dependent e2e cases). */
export const hasGit = async (): Promise<boolean> => {
  try {
    await simpleGit().raw(['--version']);
    return true;
  } catch {
    return false;
  }
};

/**
 * Commit identity via env so we never mutate the runner's global git config.
 * `tuck`'s initRepo runs `git init` but sets no user.name/email, so a fresh CI
 * runner with no global identity would fail `git commit` without this.
 */
export const gitIdentityEnv = (): Record<string, string> => ({
  GIT_AUTHOR_NAME: 'tuck-e2e',
  GIT_AUTHOR_EMAIL: 'e2e@tuck.test',
  GIT_COMMITTER_NAME: 'tuck-e2e',
  GIT_COMMITTER_EMAIL: 'e2e@tuck.test',
});
