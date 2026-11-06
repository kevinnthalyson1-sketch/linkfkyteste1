# Linkfly: guia de instalação e teste

Pacote completo: painel dos clientes, painel de administração, robô, WhatsApp (Evolution API), HTTPS automático.

## O que você precisa
1. Um servidor Linux (VPS) com 2 GB de memória ou mais e Docker instalado.
2. Um domínio apontando para o IP do servidor (registro A).
3. Um número de WhatsApp para testar (de preferência um chip dedicado).
4. Opcional: conta SMTP (e-mail) e uma conta Hotmart ou Kiwify para cobrança.

## Instalar
```
cp .env.example .env      # preencha todos os campos
mkdir -p dados
docker compose up -d --build
```
Abra `https://SEU-DOMINIO`. Crie a sua conta usando exatamente o e-mail definido em `ADMIN_EMAIL`:
ela vira a conta de administrador e ganha o menu **Clientes**.

**Importante:** o cadastro não confirma o e-mail. Por isso o servidor **só aceita criar a conta do `ADMIN_EMAIL` se `CONVITE` tiver 12 ou mais caracteres** (e o convite é conferido em todo cadastro). Crie a sua conta logo depois de ligar o sistema, antes de divulgar o endereço.

## Primeiro teste (faça antes de convidar clientes)
1. WhatsApp e grupos: gere o QR code, conecte, carregue os grupos.
2. Escolha um grupo para copiar e um para postar (use um grupo de teste só seu).
3. Lojas: cadastre ao menos um ID (ex.: Amazon) e ative o robô em Automação.
4. Poste uma oferta no grupo de origem e veja se chega ao destino com o seu link e a foto.
5. Clique no link recebido e confira o clique no painel de Desempenho.
6. Peça a um amigo para se cadastrar: confira o e-mail de recuperação de senha e o painel Clientes.

## Cobrança
- Cadastro novo ganha **10 dias de teste grátis** (fixo). Depois, o robô pausa até a assinatura ser renovada.
- **Teste do Plano Pro por 5 dias**: qualquer conta (grátis ou Plano Plus) ativa em **Planos > Testar 5 dias grátis**, uma única vez. Durante os 5 dias valem todos os limites do Plano Pro; ao fim, a conta volta ao plano que tinha (quem estava no grátis não ganha dias extras além do que o teste cobre). Um e-mail avisa 24 h antes do fim. A duração fica em `TRIAL_P2_DIAS` no `server.js`.
- Etiqueta **Mais vantajoso para iniciantes** no Plano Plus (painel e site).
- Manual: em **Clientes**, botões **+10 dias** e **+30 dias**, e o seletor de plano de cada cliente.

### Planos
| | Grátis (10 dias) | Plano Plus · R$ 35,90 | Plano Pro · R$ 69,90 |
|---|---|---|---|
| Grupos de origem (copiar) | 2 | 5 | 10 |
| Grupos de destino (postar) | 1 | 2 | 10 |
| Tempo do robô por dia | 3 horas | dia todo | dia todo |
| Envios por dia | 50 | 150 | ilimitados |
| "Enviar agora" | dentro dos 50 do dia | 5 por dia | ilimitado |
| Busca de ofertas Shopee | 1 palavra-chave, 1 oferta por busca, a cada 2 h | 3 palavras, 3 ofertas, a cada 1 h | 10 palavras, 5 ofertas, a cada 30 min |
| Intervalo entre envios | 1 min | 30 s ou 1 min | 10 s, 30 s ou 1 min |
| Horários de pico | não | sim | sim |
| Mensagem personalizada | não (3 modelos prontos) | sim | sim |
| Resumo da semana, exportar CSV, Sub ID personalizado | não | não | sim |

Os limites ficam no objeto `PLANOS` no início do `server.js`. O administrador sempre tem os recursos do Plano Pro.
- Automático: na Hotmart ou Kiwify, aponte o webhook de compra para `https://SEU-DOMINIO/webhook/pagamento/PAGAMENTO_SEGREDO`.
  O cliente deve comprar com o mesmo e-mail do cadastro. Os campos variam por plataforma: faça uma compra de teste e leia `docker compose logs app`.

## Segurança e rotina
- `SEGREDO_CHAVE` criptografa o segredo da Shopee no disco. Guarde essa chave: sem ela, os segredos salvos não abrem. Ela precisa ter exatamente 64 caracteres hexadecimais; se estiver errada, o servidor não liga e explica o motivo nos logs.
- O banco é o arquivo `dados/data.json`, com cópia diária (7 últimas). Copie a pasta `dados` para fora do servidor com frequência.
- Atualizar: `git pull` (ou troque os arquivos) e `docker compose up -d --build`.
- Ver erros: `docker compose logs -f app`.

## Variáveis (.env)
| Variável | Para que serve |
|---|---|
| DOMINIO, PUBLIC_URL | endereço do painel (com https) |
| EVO_KEY, DB_SENHA | chaves internas do Evolution e do banco dele |
| SEGREDO_CHAVE | criptografia (64 caracteres hex) |
| ADMIN_EMAIL | e-mail da conta administradora |
| CONVITE | código exigido no cadastro; mínimo 12 caracteres (obrigatório para criar o administrador) |
| LINK_PLANO1, LINK_PLANO2 | links de compra de cada plano (LINK_ASSINATURA é o link padrão) |
| PAGAMENTO_SEGREDO | parte secreta da URL do webhook de pagamento |
| HOTMART_HOTTOK / KIWIFY_TOKEN | assinatura da plataforma; sem uma delas o webhook de pagamento recusa tudo |
| PRODUTO_PLANO1, PRODUTO_PLANO2 | IDs de produto ou oferta de cada plano (separe vários por vírgula) |
| CUPOM_CODIGO, CUPOM_PERCENTUAL, LINK_PLANO2_CUPOM | cupom do bônus de 24 h no último dia do teste (crie o cupom na Hotmart/Kiwify) |
| MINUTOS_POR_POST | minutos por oferta usados na estimativa de tempo poupado (padrão 3) |
| WEBHOOK_SEGREDO | opcional; chave do webhook do Evolution (por padrão usa EVO_KEY) |
| SMTP_* | e-mail de recuperação de senha e avisos |

## Antes de vender
- Preencha e peça revisão jurídica de `public/termos.html` e `public/privacidade.html` (são modelos).
- Fotos: para usar as logos oficiais das lojas, coloque os arquivos em `public/logos/` (amazon.png, ml.png, magalu.png, shopee.png, aliexpress.png, shein.png).
- A imagem do Evolution é `evoapicloud/evolution-api` (a antiga `atendai` não existe mais). Se quiser uma versão mais nova, veja as versões em hub.docker.com/r/evoapicloud/evolution-api/tags e troque em `docker-compose.yml`.

## Rodar no seu computador (sem Docker)
Precisa de Node 20.6 ou mais novo (`node -v`). O `npm start` já lê o arquivo `.env`.
```
cp .env.example .env     # preencha EVO_URL, EVO_KEY e PUBLIC_URL
npm install
npm start
```
- `EVO_URL`: endereço do Evolution API, sem barra no final (ex.: https://sua-evolution.onrender.com).
- `EVO_KEY`: a chave AUTHENTICATION_API_KEY do Evolution.
- `PUBLIC_URL`: endereço público do seu painel. O Evolution precisa alcançá-lo para entregar as mensagens, então `localhost` não serve: use um túnel (ngrok ou cloudflared) e coloque aqui o endereço https dele.
