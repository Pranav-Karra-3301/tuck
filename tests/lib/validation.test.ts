import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the platform module to control IS_WINDOWS
const mockIsWindows = vi.fn();
vi.mock('../../src/lib/platform.js', () => ({
  get IS_WINDOWS() {
    return mockIsWindows();
  },
}));

describe('validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('validateGitUrl', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid HTTPS URLs', async () => {
      const { validateGitUrl } = await import('../../src/lib/validation.js');
      expect(validateGitUrl('https://github.com/user/repo')).toBe(true);
      expect(validateGitUrl('https://github.com/user/repo.git')).toBe(true);
      expect(validateGitUrl('https://gitlab.com/user/repo.git')).toBe(true);
    });

    it('should accept valid SSH URLs', async () => {
      const { validateGitUrl } = await import('../../src/lib/validation.js');
      expect(validateGitUrl('git@github.com:user/repo.git')).toBe(true);
      expect(validateGitUrl('git@gitlab.com:user/repo.git')).toBe(true);
    });

    it('should reject invalid URLs', async () => {
      const { validateGitUrl } = await import('../../src/lib/validation.js');
      expect(validateGitUrl('not-a-url')).toBe(false);
      expect(validateGitUrl('')).toBe(false);
    });
  });

  describe('validateRepoName', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid repository names for GitHub', async () => {
      const { validateRepoName } = await import('../../src/lib/validation.js');
      expect(() => validateRepoName('dotfiles', 'github')).not.toThrow();
      expect(() => validateRepoName('my-dotfiles', 'github')).not.toThrow();
      expect(() => validateRepoName('dotfiles_backup', 'github')).not.toThrow();
      expect(() => validateRepoName('user.dotfiles', 'github')).not.toThrow();
    });

    it('should accept owner/repo format', async () => {
      const { validateRepoName } = await import('../../src/lib/validation.js');
      expect(() => validateRepoName('owner/repo', 'github')).not.toThrow();
      expect(() => validateRepoName('my-org/my-repo', 'github')).not.toThrow();
    });

    it('should reject invalid repository names', async () => {
      const { validateRepoName } = await import('../../src/lib/validation.js');
      expect(() => validateRepoName('', 'github')).toThrow();
      expect(() => validateRepoName('repo with spaces', 'github')).toThrow();
      expect(() => validateRepoName('repo;injection', 'github')).toThrow();
    });

    it('should reject names with path traversal', async () => {
      const { validateRepoName } = await import('../../src/lib/validation.js');
      expect(() => validateRepoName('../traversal', 'github')).toThrow();
      expect(() => validateRepoName('repo/../other', 'github')).toThrow();
    });
  });

  describe('validateDescription', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept empty descriptions', async () => {
      const { validateDescription } = await import('../../src/lib/validation.js');
      expect(() => validateDescription('')).not.toThrow();
    });

    it('should reject descriptions exceeding max length', async () => {
      const { validateDescription } = await import('../../src/lib/validation.js');
      const longDescription = 'a'.repeat(500);
      expect(() => validateDescription(longDescription)).toThrow();
    });

    it('should reject descriptions with shell metacharacters', async () => {
      const { validateDescription } = await import('../../src/lib/validation.js');
      expect(() => validateDescription('test; rm -rf /')).toThrow();
      expect(() => validateDescription('test | cat')).toThrow();
      expect(() => validateDescription('test && cmd')).toThrow();
    });
  });

  describe('validateHostname', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should accept valid hostnames', async () => {
      const { validateHostname } = await import('../../src/lib/validation.js');
      expect(() => validateHostname('github.com')).not.toThrow();
      expect(() => validateHostname('gitlab.company.com')).not.toThrow();
      expect(() => validateHostname('my-server.example.org')).not.toThrow();
    });

    it('should reject invalid hostnames', async () => {
      const { validateHostname } = await import('../../src/lib/validation.js');
      expect(() => validateHostname('')).toThrow();
      expect(() => validateHostname('invalid hostname')).toThrow();
      expect(() => validateHostname('host;injection')).toThrow();
    });

    it('should reject localhost and private IPs', async () => {
      const { validateHostname } = await import('../../src/lib/validation.js');
      expect(() => validateHostname('localhost')).toThrow();
      expect(() => validateHostname('127.0.0.1')).toThrow();
    });
  });

  describe('sanitizeErrorMessage', () => {
    beforeEach(() => {
      mockIsWindows.mockReturnValue(false);
    });

    it('should return generic message for errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');
      const error = new Error('Sensitive error details');
      expect(sanitizeErrorMessage(error, 'Generic error')).toBe('Generic error');
    });

    it('should handle string errors', async () => {
      const { sanitizeErrorMessage } = await import('../../src/lib/validation.js');
      expect(sanitizeErrorMessage('string error', 'Generic error')).toBe('Generic error');
    });
  });

  describe('GIT_OPERATION_TIMEOUTS', () => {
    it('should export timeout constants', async () => {
      const { GIT_OPERATION_TIMEOUTS } = await import('../../src/lib/validation.js');
      expect(GIT_OPERATION_TIMEOUTS).toBeDefined();
      expect(GIT_OPERATION_TIMEOUTS.CLONE).toBeDefined();
      expect(GIT_OPERATION_TIMEOUTS.FETCH).toBeDefined();
      expect(GIT_OPERATION_TIMEOUTS.PUSH).toBeDefined();
    });
  });
});
