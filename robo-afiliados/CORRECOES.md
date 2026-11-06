# Versão 8: etiqueta do Plano Plus, teste do Plano Pro e correções
**Novidades**
- Plano Plus com a etiqueta **Mais vantajoso para iniciantes** (painel e site); Plano Pro com **Mais completo**.
- **Teste de 5 dias do Plano Pro**: botão em Planos, uma vez por conta, para contas grátis e do Plano Plus. Vale todos os limites do Plano Pro e depois volta ao plano anterior. Aviso por e-mail 24 h antes do fim, faixa no topo do painel com o tempo restante e marcação em Clientes (administrador).
- Site atualizado: etiquetas, cartão do Plano Pro com o teste, textos, FAQ novo e meta description.

**Erros corrigidos**
- As mensagens de limite do plano (ex.: "seu plano permite 1 grupo de destino") não chegavam ao cliente: o painel mostrava só "Erro inesperado". Agora aparece o motivo.
- Contas novas nasciam com limite de 50 envios por dia e ficavam presas nele depois de assinar o Plano Plus ou 2. O padrão agora é 150 (o plano limita sozinho); contas antigas com 50 foram ajustadas uma vez.
- A Fila mostrava o intervalo escolhido em vez do que o plano permite (ex.: 10 s depois de voltar ao plano grátis).
- Plano Pro mostrava "de 100000 postagens" no cartão de saúde e na Mariana; agora mostra ∞.
- Link de redefinição de senha de uma conta apagada derrubava a requisição; agora responde "Link inválido".
- Webhook com mensagem sem identificador não gera mais erro no servidor.
- Mariana citava só o teste de 10 dias; agora cita também o teste do Plano Pro.
- Site: o destaque do Plano Pro (cartão elevado) era anulado pela animação de entrada; função sem uso removida; "Instalável no celular" trocado por texto fiel.
- Termos de uso: cláusula de planos e teste preenchida (continuam os campos da sua empresa, data e foro).

# Versão 7: limites dos planos
- **Plano Plus**: 2 grupos de destino e 5 usos por dia do "Enviar agora" (`agoraDia` em `PLANOS`).
- **Plano Pro**: envios por dia ilimitados (`TETO`, 100000) e "Enviar agora" ilimitado. O limite de proteção que o cliente escolhe em Proteção continua valendo, e há a opção "Ilimitado". O aquecimento de número novo continua ativo (o cliente pode desligar).
- **Plano grátis**: o robô trabalha no máximo 3 horas por dia (`horasDia`). O tempo conta enquanto o robô está ligado; ao acabar, a fila é descartada e o robô volta no dia seguinte (horário de Brasília). O "Enviar agora" não conta nesse tempo.
- Telas: Planos, Fila (aviso de tempo esgotado) e Proteção (opção Ilimitado).

