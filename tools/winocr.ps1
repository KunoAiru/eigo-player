# Windows built-in OCR (Windows.Media.Ocr) for a list of images.
#   powershell -NoProfile -ExecutionPolicy Bypass -File winocr.ps1 -List images.txt -OutDir ocr
# Writes <OutDir>/<image name>.ocr.json with the lines found by each language engine.
param(
  [Parameter(Mandatory = $true)][string]$List,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string[]]$Langs = @('ja', 'en-US')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$engines = @{}
foreach ($l in $Langs) {
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($l))
  if ($e) { $engines[$l] = $e } else { Write-Warning "OCR language not installed: $l" }
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

foreach ($path in [IO.File]::ReadAllLines($List, $utf8)) {
  if (-not $path.Trim()) { continue }
  $full = (Resolve-Path -LiteralPath $path).Path
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $out = [ordered]@{ image = $full; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; langs = [ordered]@{} }
  foreach ($l in $engines.Keys) {
    $res = Await ($engines[$l].RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $out["angle_$l"] = $res.TextAngle
    $out.langs[$l] = @($res.Lines | ForEach-Object {
      $r = $_.Words | ForEach-Object { $_.BoundingRect }
      $x = ($r | Measure-Object X -Minimum).Minimum
      $y = ($r | Measure-Object Y -Minimum).Minimum
      $x2 = ($r | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
      $y2 = ($r | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
      $words = @($_.Words | ForEach-Object {
        [ordered]@{ text = $_.Text; x = [int]$_.BoundingRect.X; y = [int]$_.BoundingRect.Y; w = [int]$_.BoundingRect.Width; h = [int]$_.BoundingRect.Height }
      })
      [ordered]@{ text = $_.Text; x = [int]$x; y = [int]$y; w = [int]($x2 - $x); h = [int]($y2 - $y); words = $words }
    })
  }
  $stream.Dispose()
  $name = [IO.Path]::GetFileNameWithoutExtension($full)
  [IO.File]::WriteAllText((Join-Path $OutDir "$name.ocr.json"), ($out | ConvertTo-Json -Depth 6), $utf8)
  Write-Output "ocr $name"
}
