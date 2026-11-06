param([string]$Email)
$nova = { [guid]::NewGuid().ToString('N') }
$evo = & $nova
$db = & $nova
$pagto = (& $nova).Substring(0, 24)
$convite = (& $nova).Substring(0, 16)
# Reaproveita a chave de criptografia de uma instalacao anterior (sem ela, os segredos salvos da Shopee nao abrem)
$segredo = $null
$antigo = Join-Path $PSScriptRoot ".env.antigo"
if (Test-Path $antigo) {
  $m = Select-String -Path $antigo -Pattern '^SEGREDO_CHAVE=([0-9a-fA-F]{64})\s*$' | Select-Object -First 1
  if ($m) { $segredo = $m.Matches[0].Groups[1].Value }
}
if (-not $segredo) { $segredo = (& $nova) + (& $nova) }
$linhas = @(
  "EVO_KEY=$evo",
  "DB_SENHA=$db",
  "ADMIN_EMAIL=$Email",
  "CONVITE=$convite",
  "LINK_ASSINATURA=",
  "LINK_PLANO1=",
  "LINK_PLANO2=",
  "HOTMART_HOTTOK=",
  "KIWIFY_TOKEN=",
  "PRODUTO_PLANO1=",
  "PRODUTO_PLANO2=",
  "PAGAMENTO_SEGREDO=$pagto",
  "PUBLIC_URL=",
  "SEGREDO_CHAVE=$segredo",
  "SMTP_HOST=",
  "SMTP_PORT=587",
  "SMTP_USER=",
  "SMTP_PASS=",
  "SMTP_FROM="
)
Set-Content -Path (Join-Path $PSScriptRoot ".env") -Value $linhas -Encoding ascii
Write-Host "Arquivo .env criado com chaves aleatorias."
Write-Host ""
Write-Host "SEU CODIGO DE CONVITE (anote; sem ele ninguem cria conta): $convite"
Write-Host "Ele tambem fica salvo no arquivo .env, na linha CONVITE=."
