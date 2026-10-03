import { describe, it, expect } from 'vitest';
import { classifyCommand, isDangerousCommand } from './_commandSafety';

describe('classifyCommand — blocks catastrophic commands', () => {
  const blocked: Array<[string, string]> = [
    ['rm -rf /', 'classic root wipe'],
    ['rm -rf /*', 'root glob wipe'],
    ['rm -fr /', 'reversed flags'],
    ['rm -rf  /', 'extra spaces'],
    ['RM -RF /', 'uppercase'],
    ['rm -r -f /', 'split flags'],
    ['rm --recursive --force /', 'long flags'],
    ['rm -rf ~', 'home dir'],
    ['rm -rf ~/', 'home dir slash'],
    ['rm -rf $HOME', 'home env var'],
    ['rm -rf /usr', 'system root usr'],
    ['rm -rf /etc/*', 'system root etc glob'],
    ['rm -rf /System', 'macOS System'],
    ['rm -rf /Users', 'all users'],
    ['rm -rf .', 'current dir'],
    ['rm -rf *', 'bare glob'],
    ['sudo rm -rf /', 'with sudo prefix'],
    ['echo hi && rm -rf /', 'chained after &&'],
    ['echo hi; rm -rf ~', 'chained after ;'],
    [':(){:|:&};:', 'fork bomb'],
    [':(){ :|:& };:', 'fork bomb spaced'],
    ['mkfs.ext4 /dev/sda1', 'format filesystem'],
    ['dd if=/dev/zero of=/dev/sda', 'dd to device'],
    ['cat foo > /dev/sda', 'redirect to raw disk'],
    ['shutdown -h now', 'shutdown'],
    ['sudo reboot', 'reboot'],
    ['halt', 'halt'],
  ];

  it.each(blocked)('blocks %j (%s)', (cmd) => {
    const verdict = classifyCommand(cmd);
    expect(verdict.blocked, `expected to block: ${cmd}`).toBe(true);
    expect(verdict.reason).toBeTruthy();
  });
});

describe('classifyCommand — allows ordinary commands', () => {
  const allowed = [
    'ls -la',
    'git status',
    'npm install',
    'rm -rf node_modules',
    'rm -rf ./build',
    'rm -rf dist',
    'rm file.txt',
    'rm -r ./tmp', // recursive but not forced, and a non-root target
    'mkdir -p src/components',
    'cat package.json',
    'find . -name "*.ts"',
    'node script.js',
    'python3 build.py',
  ];

  it.each(allowed)('allows %j', (cmd) => {
    expect(isDangerousCommand(cmd), `expected to allow: ${cmd}`).toBe(false);
  });

  it('does not block deletes of named project folders', () => {
    expect(isDangerousCommand('rm -rf node_modules .next dist')).toBe(false);
  });

  it('handles empty / whitespace input', () => {
    expect(isDangerousCommand('')).toBe(false);
    expect(isDangerousCommand('   ')).toBe(false);
  });
});

describe('classifyCommand — Windows equivalents', () => {
  // None of these were recognised before: the classifier was Unix-shaped, so a
  // forced system delete ran and was only stopped by the filesystem ACL.
  const blocked: Array<[string, string]> = [
    ['cmd /c del /f /q C:\\Windows\\System32\\drivers\\etc\\hosts', 'forced delete of a Windows system file'],
    ['del /force C:\\Windows\\notepad.exe', 'forced delete, windows path'],
    ['format C: /q', 'format a volume'],
    ['Remove-Item -Recurse -Force C:\\Windows\\Temp', 'recursive system delete'],
    ['rd /s /q C:\\Program Files\\Thing', 'recursive program files delete'],
    ['cipher /w:C', 'wipe free space'],
    ['vssadmin delete shadows /all', 'delete shadow copies'],
    ['diskpart', 'disk configuration'],
    ['bcdedit /set testsigning on', 'boot configuration'],
    ['netsh advfirewall set allprofiles state off', 'disable firewall'],
    ['Set-MpPreference -DisableRealtimeMonitoring 1', 'disable Defender'],
  ];

  for (const [cmd, why] of blocked) {
    it(`blocks ${why}: ${cmd}`, () => {
      expect(classifyCommand(cmd).blocked, cmd).toBe(true);
    });
  }

  it('still allows ordinary Windows commands', () => {
    const allowed = [
      'cmd /c echo hello',
      'tasklist',
      'del notes.txt',
      'del /f temp.log',
      'netsh advfirewall show allprofiles',
      'mkdir build',
    ];
    for (const cmd of allowed) {
      expect(classifyCommand(cmd).blocked, cmd).toBe(false);
    }
  });
});
