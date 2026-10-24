# Babel Tower - generate the local self-signed certificate for the https panel channel.
#
# The game's hidden HTML panel only loads an https page while the certificate chain
# validates (WebKit otherwise reports ERR_CERT_AUTHORITY_INVALID / neterror -202).
# This script creates a self-signed end-entity certificate with the exact layout the
# engine needs:
#   CN  = BabelTower-localhost
#   SAN = DNS:localhost + IP:127.0.0.1 + IP:::1   (the IPs MUST be IP SANs)
#   EKU = serverAuth (1.3.6.1.5.5.7.3.1)
#   KU  = DigitalSignature + KeyEncipherment
# and writes three files into -OutDir (default config\certs, gitignored):
#   bridge.pfx    PKCS#12 bundle with the private key, read by core/bridge_https.js
#   bridge.pass   the random passphrase for that pfx (plain text, also gitignored)
#   bridge.cer    DER public certificate, this is what -Trust installs
#
# Trust is opt-in: pass -Trust to install bridge.cer into CurrentUser\Root, which is the
# store the game engine (through Steam) reads. certutil is used instead of
# Import-Certificate because the latter refuses to run from a non-interactive process
# ("UI is not allowed in this operation"). Windows may show a security warning dialog;
# confirm it. After adding OR removing the certificate, Steam must be fully restarted
# (including the tray icon) - restarting only the game does not reload the trust store.
#
# Idempotent: without -Force an existing usable certificate is reused, and -Trust /
# -Untrust then only adds or removes the trust entry.
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
#   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Untrust
#   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -NoTrust -OutDir <tmp>
#
# No administrator rights are needed: CurrentUser\Root belongs to the current user.
# This file is intentionally ASCII-only so Windows PowerShell 5.1 cannot mis-read it.

[CmdletBinding()]
param(
    [string]$OutDir = "",
    [int]$Days = 1825,
    [switch]$Force,
    [switch]$Trust,
    [switch]$Untrust,
    [switch]$NoTrust,
    [switch]$PassThru
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RepoRoot "config\certs"
} elseif (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $RepoRoot $OutDir
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$PfxPath = Join-Path $OutDir "bridge.pfx"
$PassFile = Join-Path $OutDir "bridge.pass"
$CerPath = Join-Path $OutDir "bridge.cer"

function Fail([string]$Message) {
    Write-Host ("ERROR: " + $Message)
    exit 1
}

if ($Trust -and $Untrust) { Fail "-Trust and -Untrust cannot be combined." }
if ($Trust -and $NoTrust) { Fail "-Trust and -NoTrust cannot be combined." }
if ($Untrust -and $NoTrust) { Fail "-Untrust and -NoTrust cannot be combined." }
if ($Days -lt 1) { Fail "-Days must be a positive number." }

# Return the public certificate when the .cer is a usable BabelTower localhost cert,
# otherwise $null. Only the public part is read: importing a PFX that carries a private
# key may fail in restricted contexts, and the .cer is enough to judge idempotent reuse.
function Get-UsableCertificate([string]$CerFile) {
    if (-not (Test-Path -LiteralPath $CerFile)) { return $null }
    $cert = $null
    try {
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @($CerFile)
    } catch {
        return $null
    }
    if ($null -eq $cert) { return $null }
    if ($cert.Subject -notmatch "CN=BabelTower-localhost") { return $null }
    if ($cert.NotAfter -le (Get-Date).AddDays(1)) { return $null }
    $sanText = ""
    $ekuText = ""
    foreach ($ext in $cert.Extensions) {
        if ($ext.Oid.Value -eq "2.5.29.17") { $sanText = $ext.Format($true) }
        elseif ($ext.Oid.Value -eq "2.5.29.37") { $ekuText = $ext.Format($true) }
    }
    if ($sanText -notmatch "DNS Name=localhost") { return $null }
    if ($sanText -notmatch "IP Address=127\.0\.0\.1") { return $null }
    # The IPv6 loopback may be formatted expanded (0000:...:0001) or compressed (::1).
    if ($sanText -notmatch "(IP Address=(0{4}:){7}0{3}1|IP Address=0:0:0:0:0:0:0:1|IP Address=::1)") { return $null }
    if ($ekuText -notmatch "1\.3\.6\.1\.5\.5\.7\.3\.1") { return $null }
    return $cert
}

# Build the self-signed certificate in memory (never imported into a store here, so the
# private key never touches the user's key containers during generation).
function New-LocalCertificate([int]$ValidDays) {
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $request = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest -ArgumentList @(
        "CN=BabelTower-localhost",
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )

    $sanBuilder = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
    $sanBuilder.AddDnsName("localhost")
    $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
    $sanBuilder.AddIpAddress([System.Net.IPAddress]::IPv6Loopback)
    [void]$request.CertificateExtensions.Add($sanBuilder.Build())

    $ekuOids = New-Object System.Security.Cryptography.OidCollection
    [void]$ekuOids.Add((New-Object System.Security.Cryptography.Oid -ArgumentList "1.3.6.1.5.5.7.3.1"))
    [void]$request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension -ArgumentList @($ekuOids, $false)))

    $keyUsageFlags = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    [void]$request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension -ArgumentList @($keyUsageFlags, $false)))

    [void]$request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension -ArgumentList @($false, $false, 0, $false)))

    $notBefore = (Get-Date).AddDays(-1)
    $notAfter = (Get-Date).AddDays($ValidDays)
    return $request.CreateSelfSigned($notBefore, $notAfter)
}

# URL-safe base64 from 24 random bytes (32 chars, no quotes/problem characters).
function New-RandomPassphrase {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    $text = [Convert]::ToBase64String($bytes)
    $text = $text.Replace("+", "-").Replace("/", "_").Replace("=", "")
    return $text
}

function Save-CertificateFiles($Cert, [string]$Pfx, [string]$Pass, [string]$Cer) {
    $passphrase = New-RandomPassphrase
    $pfxBytes = $Cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $passphrase)
    if ($null -eq $pfxBytes -or $pfxBytes.Length -eq 0) {
        throw "PFX export returned no data (is the private key missing?)."
    }
    [System.IO.File]::WriteAllBytes($Pfx, $pfxBytes)
    [System.IO.File]::WriteAllText($Pass, $passphrase, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllBytes($Cer, $Cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
}

# Split certutil output into lines so a failure can be reported in English.
function Get-CertutilOutput($CommandOutput) {
    if ($null -eq $CommandOutput) { return "" }
    return (($CommandOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
}

try {
    if (-not (Test-Path -LiteralPath $OutDir)) {
        [void](New-Item -ItemType Directory -Path $OutDir -Force)
        Write-Host ("Created directory: " + $OutDir)
    }

    $cert = $null
    $reused = $false
    if (-not $Force) {
        $existing = Get-UsableCertificate -CerFile $CerPath
        if (($null -ne $existing) -and (Test-Path -LiteralPath $PfxPath) -and (Test-Path -LiteralPath $PassFile)) {
            $cert = $existing
            $reused = $true
            Write-Host ("Reusing existing certificate (thumbprint " + $cert.Thumbprint + "). Use -Force to regenerate.")
        } elseif ($null -ne $existing) {
            Write-Host "Existing certificate is missing its pfx/pass files; regenerating."
        } else {
            Write-Host "No usable certificate found; generating a new one."
        }
    } else {
        Write-Host "Force specified; generating a new certificate."
    }

    if ($null -eq $cert) {
        $cert = New-LocalCertificate -ValidDays $Days
        Save-CertificateFiles -Cert $cert -Pfx $PfxPath -Pass $PassFile -Cer $CerPath
        Write-Host ("Generated self-signed certificate: CN=BabelTower-localhost, " + $Days + " days, thumbprint " + $cert.Thumbprint)
    }

    Write-Host ("  pfx:      " + $PfxPath)
    Write-Host ("  passFile: " + $PassFile)
    Write-Host ("  cer:      " + $CerPath)
    Write-Host "Keep bridge.pass private: it unlocks the private key in bridge.pfx. Both are gitignored."

    $trustedState = $null
    if ($Untrust) {
        $thumbprint = $cert.Thumbprint
        $probe = & certutil.exe -user -store Root $thumbprint 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Certificate is not present in CurrentUser\Root; nothing to remove."
            $trustedState = $false
        } else {
            Write-Host "Removing certificate from CurrentUser\Root ..."
            $deleteOutput = & certutil.exe -user -delstore Root $thumbprint 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host (Get-CertutilOutput $deleteOutput)
                Fail ("certutil -user -delstore Root failed with exit code " + $LASTEXITCODE + ".")
            }
            $trustedState = $false
            Write-Host "Certificate removed from CurrentUser\Root. Fully exit and restart Steam for this to take effect."
        }
    } elseif ($Trust) {
        $thumbprint = $cert.Thumbprint
        $probe = & certutil.exe -user -store Root $thumbprint 2>&1
        if ($LASTEXITCODE -eq 0) {
            $trustedState = $true
            Write-Host "Certificate is already trusted in CurrentUser\Root."
        } else {
            Write-Host "Installing certificate into CurrentUser\Root (Windows may show a security warning; click Yes) ..."
            $addOutput = & certutil.exe -user -addstore Root $CerPath 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host (Get-CertutilOutput $addOutput)
                Fail ("certutil -user -addstore Root failed with exit code " + $LASTEXITCODE + ". Run this command from a normal interactive console and confirm the security warning.")
            }
            $trustedState = $true
            Write-Host "Certificate trusted in CurrentUser\Root. Fully exit and restart Steam (tray icon too) before opening the game."
        }
    } else {
        Write-Host "Trust not requested (pass -Trust to install into CurrentUser\Root)."
    }

    if ($PassThru) {
        [pscustomobject]@{
            Thumbprint = $cert.Thumbprint
            Subject = $cert.Subject
            NotAfter = $cert.NotAfter
            Pfx = $PfxPath
            PassFile = $PassFile
            Cer = $CerPath
            Reused = $reused
            Trusted = $trustedState
        }
    }
} catch {
    Fail ($_.Exception.GetType().Name + ": " + $_.Exception.Message)
}
