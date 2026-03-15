export const targets = [
  {
    id: 'linux-amd64',
    label: 'linux/amd64',
    pkgTarget: 'node18-linux-x64',
    binaryName: 'emoji-audit-linux-amd64',
  },
  {
    id: 'linux-arm64',
    label: 'linux/arm64',
    pkgTarget: 'node18-linux-arm64',
    binaryName: 'emoji-audit-linux-arm64',
  },
  {
    id: 'windows-amd64',
    label: 'windows/amd64',
    pkgTarget: 'node18-win-x64',
    binaryName: 'emoji-audit-windows-amd64.exe',
  },
  {
    id: 'windows-arm64',
    label: 'windows/arm64',
    pkgTarget: 'node18-win-arm64',
    binaryName: 'emoji-audit-windows-arm64.exe',
  },
];
