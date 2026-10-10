# Critério de classificação

Este documento é a especificação do classificador. Escrevi antes do código, e os limiares abaixo são os
mesmos de `src/classifier/thresholds.ts`. Se um mudar, o outro muda junto.

## Entrada

Uma série de views **incrementais** por hora desde a publicação: `points[i] = { hour: i, views: n }`, onde
`views` é quantas views o post ganhou naquela hora (não o acumulado). As horas começam em 0 e são
consecutivas, sem buracos. Escolhi incremental porque todos os sinais olham para a forma da curva hora a
hora; com o acumulado, quem chama faria a diferença e eu teria de validar monotonicidade.

A API recusa com 400 série com menos de 24 horas, com hora faltando ou fora de ordem, views negativas ou não
inteiras, e mais de 2160 horas (90 dias). Recusa com 422 a série que termina depois do "agora" do servidor
(`published_at` + horas maior que o relógio).

## Saída

- `classification`: `legitimo`, `suspeito` ou `inconclusivo`.
- `reason`: frase em português que explica a decisão com os números medidos.
- `signals`: para cada sinal, o valor medido, o limiar, se foi avaliado, se disparou e um texto curto.

## Notação

`x[t]` são as views da hora `t`, `n` é o número de horas, `base` é a mediana da série inteira. A mediana
resiste a picos: um pico de 2 horas numa série de 100 horas não mexe nela.

## Sinais

### 1. `pico_sem_cauda`: pico isolado que volta à linha de base

A ideia: views compradas chegam num bloco de 1 a 3 horas e param. Um vídeo que estoura de verdade é
compartilhado, entra em recomendação e continua recebendo views por muitas horas, com decaimento gradual.

1. `p` é a hora de maior `x`. O excesso do pico é `x[p] - base`.
2. O pico só conta se for relevante: `x[p] >= 5 × max(base, 1)` e excesso `>= 100` views. Sem pico relevante,
   o sinal não é avaliado.
3. O "bloco do pico" são as horas contíguas a `p` cujo excesso é pelo menos 50% do excesso do pico.
   A largura do bloco é reportada.
4. Cauda: soma do excesso positivo nas **10 horas seguintes ao fim do bloco**, dividida pelo excesso do pico.
   Um decaimento exponencial com meia-vida de 3 horas dá cerca de 2; um pico comprado dá perto de 0.
5. Precisa haver 10 horas depois do bloco. Se o pico está no fim da série, a cauda não é observável.

Dispara se `cauda < 0,3` **e** largura do bloco `<= 6` horas (bloco mais largo é patamar, não pico, e é
assunto dos outros sinais). Entre 0,3 e 0,8 é zona cinza.

### 2. `queda_abrupta`: patamar que cai de uma hora para outra e não volta

Audiência humana desacelera aos poucos. Um patamar sustentado por robô termina quando o pacote acaba: de uma
hora para outra as views despencam e ficam baixas.

Para cada hora `t` com pelo menos 6 horas antes e 3 depois:

- `antes` = mediana de `x[t-6 .. t-1]`, `depois` = mediana de `x[t .. t+5]` (até onde houver série).
- Só avalia se `antes >= 30` views/h (abaixo disso, ruído de contagem produz quedas grandes à toa).
- Queda na hora: `1 - x[t] / x[t-1]`. Queda sustentada: `1 - depois / antes`.
- Valor de `t`: o menor dos dois (as duas coisas precisam acontecer).

O valor do sinal é o maior entre todos os `t` avaliados. Dispara se `>= 0,75`.

O pico comprado curto não dispara este sinal: um bloco de até 3 horas não move a mediana de 6 horas
anteriores. Isso mantém os sinais separados e o motivo mais preciso.

### 3. `repeticao_mecanica`: variação menor que a de pessoas reais

Contagem de pessoas tem ruído: mesmo uma audiência estável oscila pelo menos como uma Poisson, em que a
variância é igual à média. Na prática oscila mais. Um robô que entrega 200 views por hora entrega 200, 201,
200, 199.

Para cada janela de 12 horas consecutivas com média `>= 10` views/h, calcula o índice de dispersão
`variância / média`. O valor do sinal é o menor índice encontrado. Dispara se `< 0,1`.

Para uma Poisson pura com 12 amostras, um índice abaixo de 0,1 tem probabilidade da ordem de 1 em 100 mil por
janela. Audiência real (com ciclo diário, tendência e ruído extra) fica bem acima de 1. Janelas com tendência
inflam a variância, então o erro aqui tende a ser deixar passar, não acusar.

### 4. `rajadas_periodicas`: rajadas em intervalo fixo

Robô agendado entrega um lote a cada `k` horas.

1. Linha de base local: mediana de `x` nas 12 horas antes e depois de cada hora.
2. Rajada: hora com `x >= 3 × base local` e `x - base local >= 50`. Horas de rajada coladas contam como uma.
3. Com pelo menos 4 rajadas, calcula os intervalos entre inícios consecutivos e o intervalo mais comum `k`.
4. Valor: fração dos intervalos exatamente iguais a `k`.

Dispara se valor `>= 0,8` e `k` entre 2 e 12 horas. Periodicidade de 24 horas é ignorada de propósito:
é o ciclo dia/noite de gente de verdade.

## Como os sinais se combinam

Na ordem, a primeira regra que bate decide:

1. Série com menos de 24 horas: `inconclusivo` (a API nem chega aqui, devolve 400).
2. Algum sinal disparou: `suspeito`. O motivo junta a explicação de cada sinal que disparou.
3. Pico relevante com cauda na zona cinza (0,3 a 0,8) ou não observável: `inconclusivo`.
4. Volume baixo (mediana `< 5` views/h e máximo `< 100`): `inconclusivo`. Com tão poucas views, ruído e padrão
   ficam parecidos e nenhum sinal tem força.
5. Série com menos de 48 horas: `inconclusivo`. Cedo demais para afirmar que é legítima.
6. Caso contrário: `legitimo`.

Um sinal sozinho basta para `suspeito` porque cada limiar foi posto onde audiência humana quase nunca chega
(ver acima). A escolha de exigir só um sinal aumenta o recall; o custo é que um falso disparo de qualquer
sinal vira acusação. A taxa medida no dataset está no README.

## Quando prefere não acusar

A regra 3 é o caso principal: um pico de 8.000 views na penúltima hora da série. Pode ser compra, pode ser o
começo de um viral. Sem ver as horas seguintes não dá para saber, e acusar um criador por um vídeo que está
estourando agora é exatamente o erro que o enunciado pede para evitar. A resposta diz quantas horas faltam
observar. Há um teste para isso (`test/unit/classify.test.ts`) e um exemplo no README.

## O que o critério NÃO detecta

- **Bots que imitam curva orgânica.** Quem compra views com subida gradual, decaimento exponencial e ruído
  realista passa por todos os sinais. O classificador olha só para a forma da série, e essa forma é copiável.
- **Compra gradual diluída.** Somar 20% de views falsas espalhadas ao longo de dias, com ruído, não muda a
  forma da curva de um jeito que estes sinais vejam.
- **Patamar com ruído.** Um robô que adiciona variação aleatória na escala de uma Poisson escapa de
  `repeticao_mecanica`. O mesmo vale para patamar artificial somado a muita audiência real: a variância real
  mascara a constância do robô. Parte do platô mecânico do dataset escapa por isso.
- **Rajadas com intervalo irregular** ou periódicas a cada 24 horas.
- **Pico comprado no fim da série.** Cai em `inconclusivo` até haver horas suficientes depois.
- **Mais de um pico.** Só o maior pico é examinado por `pico_sem_cauda`. Um pico comprado menor que um viral
  orgânico no mesmo post passa.
- **Contas pequenas.** Abaixo de 5 views/h de mediana o resultado é `inconclusivo`.
- **Causas legítimas de queda abrupta.** Post apagado, arquivado, tornado privado ou retirado de uma
  recomendação também derruba views de uma hora para outra. O sinal descreve o formato, não a intenção;
  `suspeito` quer dizer "merece revisão humana", não "fraude comprovada".
- **Ausência de ciclo dia/noite.** Pensei em usar, mas depende do fuso da audiência, e audiência
  internacional achata o ciclo. Ficou de fora.

## Dataset sintético

Gerado por `npm run dataset` com PRNG próprio (mulberry32, semente fixa), sem rede. Cenários com rótulo
verdadeiro:

| Rótulo | Cenário | O que simula |
|---|---|---|
| legítimo | `crescimento_normal` | subida nas primeiras horas, decaimento lento, ciclo diário |
| legítimo | `viral_organico` | linha base, decolagem em algumas horas, pico de 10 a 60 vezes a base, decaimento exponencial com meia-vida de 3 a 12 horas |
| legítimo | `ciclo_diario` | audiência estável com ciclo dia/noite forte |
| legítimo | `criador_pequeno` | poucas views por hora, ruído alto, pequenas ondas |
| suspeito | `pico_comprado` | série orgânica mais um bloco de 1 a 3 horas de 10 a 60 vezes a base |
| suspeito | `plato_mecanico` | patamar quase constante entregue por robô sobre pouca audiência real |
| suspeito | `queda_abrupta` | patamar artificial (com ruído, não constante) que some de uma hora para outra |
| suspeito | `bot_periodico` | rajadas de 1 hora a cada 3 a 8 horas |

O ruído orgânico é Poisson com média multiplicada por um fator log-normal (superdispersão), que é como
contagem de pessoas costuma se comportar. Os parâmetros de cada cenário estão em `src/dataset/generate.ts`.

O dataset foi feito por mim, com os sinais em mente. Ele mede se o classificador faz o que este documento
diz, não se acerta em dados reais. A taxa de falso positivo dele é um limite inferior otimista.
