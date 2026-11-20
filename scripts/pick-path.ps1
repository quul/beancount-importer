$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) {
    throw 'An interactive Windows desktop is required.'
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$initial = $env:BEAN_IMPORT_PICKER_INITIAL
$fallback = $env:BEAN_IMPORT_PICKER_FALLBACK

if ($env:BEAN_IMPORT_PICKER_KIND -eq 'ledgerRoot') {
    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = '选择账本目录'
    $dialog.UseDescriptionForTitle = $true
    $dialog.InitialDirectory = $fallback
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Container -ErrorAction SilentlyContinue)) {
        $dialog.SelectedPath = $initial
    }
} else {
    $dialog = [System.Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = '选择 Python 可执行文件'
    $dialog.Filter = '可执行文件 (*.exe)|*.exe'
    $dialog.InitialDirectory = $fallback
    if ($initial -and (Test-Path -LiteralPath $initial -PathType Leaf -ErrorAction SilentlyContinue)) {
        $dialog.FileName = [System.IO.Path]::GetFullPath($initial)
        $dialog.InitialDirectory = Split-Path -LiteralPath $dialog.FileName
    }
}

$owner = [System.Windows.Forms.Form]::new()
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
try {
    $owner.Show()
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        if ($env:BEAN_IMPORT_PICKER_KIND -eq 'ledgerRoot') {
            [Console]::Write($dialog.SelectedPath)
        } else {
            [Console]::Write($dialog.FileName)
        }
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
