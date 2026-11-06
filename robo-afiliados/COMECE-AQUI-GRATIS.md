# Linkfly grátis no seu computador (passo a passo para quem não é de tecnologia)

Custo: R$ 0. O sistema roda no seu computador e fica no ar enquanto ele estiver ligado, com internet e sem entrar em modo de descanso.

## O que você precisa
- Um computador com Windows 10 ou 11, de preferência com 8 GB de memória ou mais.
- Internet estável.
- Um chip de WhatsApp só para o teste (o WhatsApp pode bloquear números que usam automação).

## Passo 1: instalar o Docker Desktop (uma vez só)
1. Entre em https://www.docker.com/products/docker-desktop e baixe a versão para Windows.
2. Instale clicando em "Next" até o fim. Se pedir para reiniciar o computador, reinicie.
3. Abra o **Docker Desktop**. Na primeira vez ele pede para aceitar os termos. Espere até aparecer que está funcionando (um ícone de baleia, sem mensagem de carregando). Pode levar alguns minutos.

## Passo 2: preparar a pasta
1. Baixe o arquivo `linkfly-pacote.zip`.
2. Clique nele com o botão direito, "Extrair tudo", e escolha uma pasta simples, como `C:\linkfly`.
3. Entre na pasta `robo-afiliados`.

## Passo 3: ligar o sistema
1. Dê dois cliques em **INICIAR.bat**.
2. Se aparecer um aviso azul do Windows, clique em "Mais informações" e depois em "Executar assim mesmo".
3. Ele pergunta o seu e-mail. Digite o e-mail que você vai usar como administrador e aperte Enter.
4. Espere. Na primeira vez demora de 5 a 10 minutos, porque baixa os programas. Quando terminar, o navegador abre em `http://localhost:3000`.

## Passo 4: criar a sua conta de administrador
1. Clique em "Criar conta".
2. Use **o mesmo e-mail** que digitou no passo anterior.
3. No código de convite, digite o código que está no arquivo `.env`, na linha `CONVITE=` (abra com o Bloco de Notas). Ele também apareceu na tela preta do passo anterior. **Crie a sua conta antes de compartilhar o endereço com qualquer pessoa.**
4. Marque a caixa dos termos e crie a conta. No menu vai aparecer **Clientes** (só para você).

## Passo 5: conectar o WhatsApp e testar
1. **WhatsApp e grupos**: "Gerar QR code". No celular: WhatsApp, "Aparelhos conectados", "Conectar um aparelho", e escaneie. Depois clique em "Carregar meus grupos".
2. Crie dois grupos de teste. Marque um como **Copiar** (origem) e outro como **Postar** (destino). Salve.
3. **Lojas**: coloque o seu ID de afiliado de pelo menos uma loja (por exemplo, a Amazon).
4. **Automação**: deixe o intervalo em 1 minuto e clique em "Ativar robô".
5. Poste uma oferta com link no grupo de origem (de preferência por outro número). Em cerca de 1 minuto ela aparece no grupo de destino com o seu ID.

## Passo 6: chamar as 2 pessoas para testar
1. Dê dois cliques em **COMPARTILHAR.bat**. Na primeira vez ele instala um programa gratuito (Cloudflared). Quando terminar, feche a janela e abra o COMPARTILHAR.bat de novo.
2. Vai aparecer um endereço que termina com `trycloudflare.com`. Copie e envie para as pessoas, junto com o código de convite (o mesmo da linha `CONVITE=` do `.env`). Não publique esse código em lugar aberto.
3. **Não feche essa janela** enquanto elas estiverem testando. Se fechar e abrir de novo, o endereço muda e você precisa mandar o novo.
4. Cada pessoa cria a conta dela, conecta o **próprio** WhatsApp (chip de teste) e escolhe os grupos dela. Cada uma ganha 10 dias de teste grátis (você pode somar +10 ou +30 dias em **Clientes**).
5. Em **Clientes** você acompanha o uso de cada uma.

## Como desligar e ligar depois
- Para desligar: **PARAR.bat**. Os dados ficam guardados.
- Para ligar de novo: **INICIAR.bat**.
- Se o computador reiniciar, abra o Docker Desktop e espere. O sistema volta sozinho.

## O que muda nesta versão grátis
- O sistema só funciona com o computador ligado. Se ele desligar, hibernar ou ficar sem internet, o robô para.
- **Contagem de cliques desligada**: a tela Desempenho não mostra cliques (os cliques continuam aparecendo no painel da própria loja). Isso acontece porque o endereço grátis muda, e os links dos grupos quebrariam. Quando você tiver um servidor com endereço fixo, a contagem liga.
- O link de recuperação de senha não é enviado por e-mail. Se alguém esquecer a senha, use em **Clientes** o botão "Link de senha" e mande para a pessoa.
- No Windows, em Configurações, Energia, coloque "Suspender" como "Nunca" enquanto estiver testando.

## Se algo der errado
Dê dois cliques em **VER-ERROS.bat** e me mande o que aparecer na tela.

## Quando for vender
Aí vale ter um servidor próprio, que fica ligado o tempo todo e tem endereço fixo. O passo a passo está no `README.md`.
