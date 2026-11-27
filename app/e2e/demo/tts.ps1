# Narration with a voice built into Windows (OneCore speech, offline, free). One WAV per segment, plus durations.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 -Segments narration.json -Out audioDir [-Voice "Microsoft Mark"] [-Rate 1.0]
param(
  [Parameter(Mandatory = $true)][string]$Segments,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Voice = "Microsoft Mark",
  [double]$Rate = 1.0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
if ($null -eq $v) { throw "Voice not installed: $Voice" }
$synth.Voice = $v
$synth.Options.SpeakingRate = $Rate

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$items = Get-Content -Raw -Encoding UTF8 $Segments | ConvertFrom-Json
$result = @()
foreach ($item in $items) {
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" + [System.Security.SecurityElement]::Escape($item.text).Replace("|", "<break time='450ms'/>") + "</speak>"
  $stream = Wait-Op ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  [void](Wait-Op ($reader.LoadAsync($size)) ([uint32]))
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  $file = Join-Path $Out ($item.id + ".wav")
  [IO.File]::WriteAllBytes($file, $bytes)
  # WAV header: byte rate at offset 28; the data chunk follows the fmt chunk.
  $byteRate = [BitConverter]::ToUInt32($bytes, 28)
  $dataSize = $size - 44
  for ($i = 12; $i -lt [Math]::Min($size - 8, 200); $i++) {
    if ($bytes[$i] -eq 0x64 -and $bytes[$i + 1] -eq 0x61 -and $bytes[$i + 2] -eq 0x74 -and $bytes[$i + 3] -eq 0x61) { $dataSize = [BitConverter]::ToUInt32($bytes, $i + 4); break }
  }
  $result += [pscustomobject]@{ id = $item.id; file = ($item.id + ".wav"); seconds = [Math]::Round($dataSize / $byteRate, 3) }
}
ConvertTo-Json -InputObject @($result) | Out-File -Encoding utf8 (Join-Path $Out "durations.json")
$result | Format-Table -AutoSize | Out-String
