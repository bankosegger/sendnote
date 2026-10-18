# Installs the sendnote CLI into %LOCALAPPDATA%\sendnote (override with
# $env:SENDNOTE_INSTALL_DIR) and adds it to the user PATH (skip that with
# $env:SENDNOTE_NO_MODIFY_PATH=1).
#
#   irm __SENDNOTE_URL__/install.ps1 | iex
#
# Served by server.js, which fills in the URL below with its own origin.

& {
  $ErrorActionPreference = 'Stop'

  $url = if ($env:SENDNOTE_URL) { $env:SENDNOTE_URL } else { '__SENDNOTE_URL__' }
  $dir = if ($env:SENDNOTE_INSTALL_DIR) { $env:SENDNOTE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'sendnote' }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'sendnote install: Node.js 20+ is required (https://nodejs.org).'
  }
  $nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 20) {
    throw "sendnote install: Node.js 20+ is required, found $(node -v)."
  }

  # Windows PowerShell 5.1 doesn't enable TLS 1.2 by default.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path $dir 'sendnote.download.js'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/cli.js" -OutFile $tmp
    # Catch an HTML error page or truncated download before installing it.
    # (Under 'Stop', PowerShell 5.1 would turn node's stderr into an exception.)
    & { $ErrorActionPreference = 'Continue'; node --check $tmp 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw 'sendnote install: downloaded file is not a valid script.' }
    Move-Item -Force $tmp (Join-Path $dir 'sendnote.js')
  } finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  }

  Set-Content -Path (Join-Path $dir 'sendnote.cmd') -Encoding ASCII -Value '@node "%~dp0sendnote.js" %*'

  if (-not $env:SENDNOTE_NO_MODIFY_PATH) {
    # Read/write the raw registry value: [Environment]::SetEnvironmentVariable
    # would expand and flatten entries like %USERPROFILE%\bin for good.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (-not (($userPath -split ';') -contains $dir)) {
      $key.SetValue('Path', ($(if ($userPath) { "$($userPath.TrimEnd(';'));" } else { '' }) + $dir), 'ExpandString')
      # Setting and clearing a dummy variable broadcasts WM_SETTINGCHANGE, so
      # newly opened terminals pick up the PATH change without a re-login.
      [Environment]::SetEnvironmentVariable('SENDNOTE_INSTALL_TMP', '1', 'User')
      [Environment]::SetEnvironmentVariable('SENDNOTE_INSTALL_TMP', $null, 'User')
      $env:Path = "$env:Path;$dir"
    }
    $key.Close()
  }

  Write-Host "Installed sendnote to $dir (server: $url)"
  Write-Host 'Try it: echo hello | sendnote   (open a new terminal if the command is not found)'
}
