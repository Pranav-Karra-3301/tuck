import { describe, it, expect } from 'vitest';
import { isShellFile, isPowerShellFile } from '../../src/lib/merge.js';

describe('merge', () => {
  describe('isShellFile', () => {
    describe('Unix shell files', () => {
      it('should detect .zshrc', () => {
        expect(isShellFile('~/.zshrc')).toBe(true);
        expect(isShellFile('/home/user/.zshrc')).toBe(true);
      });

      it('should detect .bashrc', () => {
        expect(isShellFile('~/.bashrc')).toBe(true);
        expect(isShellFile('/home/user/.bashrc')).toBe(true);
      });

      it('should detect .bash_profile', () => {
        expect(isShellFile('~/.bash_profile')).toBe(true);
      });

      it('should detect .profile', () => {
        expect(isShellFile('~/.profile')).toBe(true);
      });

      it('should detect .zprofile', () => {
        expect(isShellFile('~/.zprofile')).toBe(true);
      });

      it('should detect .aliases', () => {
        expect(isShellFile('~/.aliases')).toBe(true);
      });

      it('should detect .functions', () => {
        expect(isShellFile('~/.functions')).toBe(true);
      });

      it('should detect fish config', () => {
        expect(isShellFile('~/.config/fish/config.fish')).toBe(true);
      });
    });

    describe('PowerShell profile files', () => {
      it('should detect PowerShell profile', () => {
        expect(isShellFile('Microsoft.PowerShell_profile.ps1')).toBe(true);
        expect(
          isShellFile('C:\\Users\\test\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1')
        ).toBe(true);
      });

      it('should detect profile.ps1', () => {
        expect(isShellFile('profile.ps1')).toBe(true);
        expect(isShellFile('/path/to/profile.ps1')).toBe(true);
      });
    });

    describe('non-shell files', () => {
      it('should not detect .gitconfig', () => {
        expect(isShellFile('~/.gitconfig')).toBe(false);
      });

      it('should not detect .vimrc', () => {
        expect(isShellFile('~/.vimrc')).toBe(false);
      });

      it('should not detect random .ps1 files', () => {
        // Only profile.ps1 and Microsoft.PowerShell_profile.ps1 are shell files
        expect(isShellFile('random-script.ps1')).toBe(false);
      });
    });
  });

  describe('isPowerShellFile', () => {
    it('should detect .ps1 files', () => {
      expect(isPowerShellFile('script.ps1')).toBe(true);
      expect(isPowerShellFile('Microsoft.PowerShell_profile.ps1')).toBe(true);
      expect(isPowerShellFile('C:\\Users\\test\\script.ps1')).toBe(true);
    });

    it('should detect .psm1 module files', () => {
      expect(isPowerShellFile('module.psm1')).toBe(true);
      expect(isPowerShellFile('C:\\Modules\\MyModule.psm1')).toBe(true);
    });

    it('should detect .psd1 data files', () => {
      expect(isPowerShellFile('manifest.psd1')).toBe(true);
      expect(isPowerShellFile('C:\\Modules\\MyModule.psd1')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isPowerShellFile('SCRIPT.PS1')).toBe(true);
      expect(isPowerShellFile('Module.PSM1')).toBe(true);
      expect(isPowerShellFile('Data.PSD1')).toBe(true);
    });

    it('should not detect non-PowerShell files', () => {
      expect(isPowerShellFile('script.sh')).toBe(false);
      expect(isPowerShellFile('script.bash')).toBe(false);
      expect(isPowerShellFile('config.json')).toBe(false);
      expect(isPowerShellFile('.zshrc')).toBe(false);
    });
  });
});
