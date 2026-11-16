#requires -Version 5.1
<#
.SYNOPSIS
Shows Meyers' Det Velkendte - Portionspakket lunch menu.
.DESCRIPTION
Downloads the published menu from https://meyers.dk/ugens-menuer.
Uses the computer's local date. Week means the current Monday through Friday.
Displays colored headings and labels in the console.
Download progress is suppressed for faster transfers in Windows PowerShell.
Halal, vegetarian, and vegan hot dishes are hidden unless explicitly included.
Use -h to show available options without fetching the menu.
.PARAMETER Week
Shows the whole working week's menu instead of today's menu.
.PARAMETER IncludeAll
Includes halal, vegetarian, and vegan hot dishes, which are hidden by default.
.PARAMETER Help
Shows available options and exits. Alias: -h.
.EXAMPLE
.\WhatsForLunch.ps1
.EXAMPLE
.\WhatsForLunch.ps1 -Week
.EXAMPLE
.\WhatsForLunch.ps1 -IncludeAll
.EXAMPLE
.\WhatsForLunch.ps1 -h
#>
[CmdletBinding()]
param(
    [Alias('w')]
    [switch]$Week,
    [switch]$IncludeAll,
    [Alias('h')]
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
if ($Help) {
    Write-Output @'
Usage: .\WhatsForLunch.ps1 [-Week] [-IncludeAll] [-Help]

  -Week (-w)    Show the whole working week's menu instead of today's.
  -IncludeAll   Include 'Varm ret, halal', 'Varm ret, vegetarisk', and
                'Varm ret, vegansk' (all hidden by default).
  -Help (-h)    Show this help and exit without downloading the menu.
'@
    return
}

$url = 'https://meyers.dk/ugens-menuer'
$menuName = 'Det Velkendte - Portionspakket'
$today = (Get-Date).Date
$monday = $today.AddDays(-(([int]$today.DayOfWeek + 6) % 7))
$culture = [System.Globalization.CultureInfo]::GetCultureInfo('da-DK')

$excludedSections = @('Varm ret, halal', 'Varm ret, vegetarisk', 'Varm ret, vegansk')

if (-not $Week -and $today.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
    Write-Output "No lunch menu today ($($today.ToString('yyyy-MM-dd'))): it is the weekend."
    return
}

$previousProgressPreference = $ProgressPreference
try {
    # Windows PowerShell's per-chunk progress updates are expensive for this large page.
    $ProgressPreference = 'SilentlyContinue'
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
}
catch {
    throw "Could not download the Meyers menu from ${url}: $($_.Exception.Message)"
}
finally {
    $ProgressPreference = $previousProgressPreference
}

# Nuxt stores JSON values in a shared table; object properties and array entries are references.
$payload = [regex]::Match(
    $response.Content,
    '<script\b[^>]*\bid=["'']__NUXT_DATA__["''][^>]*>(?<json>.*?)</script>',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $payload.Success) {
    throw 'The Meyers page no longer contains the expected menu data. The script needs updating.'
}
$data = ConvertFrom-Json -InputObject $payload.Groups['json'].Value -ErrorAction Stop
$root = $data[$data[0][1]]
$menuBlocks = $data[$data[$root.data][1]]
$blockProperty = $menuBlocks.PSObject.Properties["foodop-menu-block-$menuName"]
if ($null -eq $blockProperty -or $blockProperty.Value -lt 0) {
    throw "The '$menuName' menu was not found on the Meyers page."
}

function Get-DanishText {
    param([int]$Reference)

    $names = $data[$Reference]
    if ($null -eq $names.da) {
        throw 'A menu item is missing its Danish text. The Meyers data format may have changed.'
    }
    [System.Net.WebUtility]::HtmlDecode([string]$data[$names.da])
}

$menus = @(
    foreach ($supplierReference in $data[$blockProperty.Value]) {
        $supplier = $data[$supplierReference]
        foreach ($menuReference in $data[$supplier.menus]) {
            $menu = $data[$menuReference]
            # The block also includes other lunch concepts; match the menu's own name.
            if ((Get-DanishText $menu.names) -ine $menuName) { continue }
            $date = [datetime]::ParseExact(
                [string]$data[$menu.date], 'yyyy-MM-dd',
                [System.Globalization.CultureInfo]::InvariantCulture
            )
            [pscustomobject]@{ Date = $date; Menu = $menu }
        }
    }
)
if ($menus.Count -eq 0) {
    throw "No published menus were found for '$menuName'."
}

$dates = if ($Week) { 0..4 | ForEach-Object { $monday.AddDays($_) } } else { $today }
Write-Host ''
Write-Host $menuName -ForegroundColor White
Write-Host "Source: $url" -ForegroundColor DarkGray
foreach ($date in $dates) {
    Write-Host ''
    $heading = $culture.TextInfo.ToTitleCase($date.ToString('dddd dd. MMMM yyyy', $culture))
    if ($date -eq $today) { $heading += '  [Today]' }
    Write-Host $heading -ForegroundColor Cyan
    Write-Host ('-' * $heading.Length) -ForegroundColor Cyan
    $dailyMenus = @($menus | Where-Object { $_.Date -eq $date })
    if ($dailyMenus.Count -eq 0) {
        Write-Warning "No menu published for $($date.ToString('yyyy-MM-dd'))."
        continue
    }
    foreach ($dailyMenu in $dailyMenus) {
        $sectionReferences = @($data[$dailyMenu.Menu.menu_sections])
        if ($sectionReferences.Count -eq 0) {
            throw "The menu for $($date.ToString('yyyy-MM-dd')) has no sections."
        }
        foreach ($sectionReference in $sectionReferences) {
            $section = $data[$sectionReference]
            $label = Get-DanishText $section.names
            if (-not $IncludeAll -and $label -in $excludedSections) { continue }
            $dishReferences = @($data[$section.menu_dishes])
            if ($dishReferences.Count -eq 0) {
                throw "The '$label' section has no dishes."
            }
            Write-Host "  $label" -ForegroundColor DarkCyan
            foreach ($dishReference in $dishReferences) {
                $dish = $data[$dishReference]
                Write-Output ('    {0}' -f (Get-DanishText $dish.names))
            }
            Write-Output ''
        }
    }
}
