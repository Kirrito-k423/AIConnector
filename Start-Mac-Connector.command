#!/bin/zsh
set -eu
cd "${0:A:h}"
runtime="${AICONNECTOR_PWSH:-pwsh}"
if ! command -v "$runtime" >/dev/null 2>&1; then
  print '需要 PowerShell 7。安装后重新运行，或设置 AICONNECTOR_PWSH 为 pwsh 的完整路径。'
  print 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-macos'
  exit 2
fi
exec "$runtime" -NoLogo -NoProfile -File ./Connector.ps1 -Node mac-outer -Action Watch -PromptToken "$@"
