# Critério de classificação

Este documento é a especificação do classificador. Defini o critério antes de implementar, e a primeira
versão deste texto veio antes do código (ver a nota de uso de IA no README). Os parâmetros fixos (janelas,
mínimos de volume e o limite de `patamar_liso`) estão em `src/classifier/thresholds.ts`. Os quatro limiares
de disparo calibráveis são escolhidos por `npm run calibrate` e gravados em `src/classifier/thresholds.json`;
a tabela abaixo é gerada pelo mesmo comando, e um teste falha se ela divergir do arquivo.

## Entrada

Uma série de views **incrementais** por hora desde a publicação: `points[i] = { hour: i, views: n }`, onde
`views` é quantas views o post ganhou naquela hora (não o acumulado). As horas começam em 0 e são
consecutivas, sem buracos. Escolhi incremental porque todos os sinais olham para a forma da curva hora a
hora; com o acumulado, quem chama faria a diferença e eu teria de validar monotonicidade.

A API valida o corpo com zod (`src/schemas.ts`) e recusa com 400 série com menos de 24 horas ou mais de 2160
(90 dias), hora faltando, repetida ou fora de ordem, views negativas, não inteiras ou acima de 1 bilhão por
hora, e `published_at` que não seja data e hora ISO 8601 existente com fuso. Recusa com 422 a série que termina depois do "agora" do servidor
(`published_at` + horas maior que o relógio).

## Saída

- `classification`: `legitimo`, `suspeito` ou `inconclusivo`.
- `reason`: frase em português que explica a decisão com os números medidos.
- `signals`: para cada sinal, o valor medido, o limiar, se foi avaliado, se disparou e um texto curto.

## Notação

`x[t]` são as views da hora `t`, `n` é o número de horas, `base` é a mediana da série inteira. A mediana
resiste a picos: um pico de 2 horas numa série de 100 horas não mexe nela.

## Limiares calibrados

Os valores usados na versão inicial, escolhidos à mão antes de existir calibração, eram 0,3 (cauda),
0,75 (queda), 0,1 (dispersão) e 0,8 (periodicidade). A calibração os substituiu; a seção "Calibração" explica
como.

<!-- thresholds:start -->
Gerado por `npm run calibrate` na partição de calibração (semente 1001). Regra: maximizar recall com falso positivo <= 2% na partição de calibração. 875 combinações testadas, 280 dentro da meta.

| sinal | dispara quando o valor fica | limiar escolhido | candidatos |
|---|---|---|---|
| pico_sem_cauda | abaixo de | 0,2 | 0,1; 0,2; 0,3; 0,4; 0,5 |
| queda_abrupta | igual ou acima de | 0,9 | 0,9; 0,85; 0,8; 0,75; 0,7; 0,65; 0,6 |
| repeticao_mecanica | abaixo de | 0,2 | 0,05; 0,1; 0,2; 0,3; 0,5 |
| rajadas_periodicas | igual ou acima de | 0,8 | 1; 0,9; 0,8; 0,7; 0,6 |

Na calibração: falso positivo 0,82%, recall 60,78%.
<!-- thresholds:end -->

## Sinais

### 1. `pico_sem_cauda`: pico isolado que volta à linha de base

A ideia: views compradas chegam num degrau de 1 a 3 horas, de nada para o pico numa hora, e param. Um vídeo
que estoura de verdade é compartilhado, entra em recomendação e continua recebendo views por muitas horas,
com decaimento gradual.

1. Todos os picos relevantes são examinados, não só o maior: o maior pico da série e até 10 outros máximos
   locais, do maior para o menor, que não estejam dentro do bloco de um pico já examinado. Uma compra pequena
   na mesma semana de um viral real não é o maior pico, e antes passava. O sinal dispara se qualquer um deles
   tiver o formato abaixo, e o motivo diz qual foi. Para o maior pico, `base` é a mediana da série; para os
   outros, é o maior entre a mediana e o nível logo antes do pico (mediana das horas `p-8` a `p-3`), porque o
   pico pode estar em cima da cauda de um viral. O excesso do pico é `x[p] - base`.
2. O pico só conta se for relevante: `x[p] >= 5 × max(base, 1)` e excesso `>= 100` views. Sem pico relevante,
   o sinal não é avaliado.
3. O "bloco do pico" são as horas contíguas a `p` cujo excesso é pelo menos 50% do excesso do pico.
   A largura do bloco é reportada.
4. Subida: soma do excesso positivo nas 3 horas antes do bloco, dividida pelo excesso do pico. Degrau dá
   perto de 0; viral e destaque na plataforma sobem aos poucos.
5. Cauda: soma do excesso positivo nas **10 horas seguintes ao fim do bloco**, dividida pelo excesso do pico.
   Um decaimento exponencial com meia-vida de 3 horas dá cerca de 2; um pico comprado dá perto de 0.
6. Precisa haver 10 horas depois do bloco. Se o pico está no fim da série, a cauda não é observável.

Dispara se a cauda fica abaixo do limiar calibrado, o bloco tem no máximo 3 horas **e** a subida fica abaixo
de 15%. Pico relevante com cauda abaixo de 0,8 que não dispara (cauda curta, bloco mais largo ou subida
gradual) é zona cinza: um viral cortado, uma live ou um destaque têm esse formato, e o resultado é
`inconclusivo`.

### 2. `queda_abrupta`: patamar que cai de uma hora para outra e não volta

Audiência humana desacelera aos poucos. Um patamar sustentado por robô termina quando o pacote acaba: de uma
hora para outra as views despencam e ficam baixas.

Para cada hora `t` com pelo menos 6 horas antes e 3 depois:

- `antes` = mediana de `x[t-6 .. t-1]`, `depois` = mediana de `x[t .. t+5]` (até onde houver série).
- Só avalia se `antes >= 30` views/h e se `antes - depois` passa de 5 desvios de Poisson do patamar
  (`5 × √antes`). Abaixo disso, ruído de contagem de conta pequena produz quedas grandes à toa.
- Queda na hora: `1 - x[t] / x[t-1]`. Queda sustentada: `1 - depois / antes`.
- Valor de `t`: o menor dos dois (as duas coisas precisam acontecer).
- Queda sazonal não conta: se a queda sustentada no mesmo horário 24 horas antes ou 24 horas depois também
  passa de 50%, é a noite chegando, e a hora `t` é ignorada. Sem isso, audiência concentrada num fuso, com
  noite perto de zero, virava suspeita todo dia.

O valor do sinal é o maior entre todos os `t` avaliados. Dispara se for igual ou maior que o limiar calibrado.

O pico comprado curto não dispara este sinal: um bloco de até 3 horas não move a mediana de 6 horas
anteriores. Isso mantém os sinais separados e o motivo mais preciso.

Também mede o índice de dispersão (variância / média) das até 12 horas antes da queda. Abaixo de 0,3 o patamar
era regular demais para gente (Poisson daria perto de 1). Isso decide se a queda, sozinha, basta para acusar
(ver "Como os sinais se combinam").

### 3. `repeticao_mecanica`: variação menor que a de pessoas reais

Contagem de pessoas tem ruído: mesmo uma audiência estável oscila pelo menos como uma Poisson, em que a
variância é igual à média. Na prática oscila mais. Um robô que entrega 200 views por hora entrega 200, 201,
200, 199.

Para cada janela de 12 horas consecutivas com média `>= 10` views/h, calcula o índice de dispersão
`variância / média`. O valor do sinal é o menor índice encontrado. Dispara abaixo do limiar calibrado.

Para uma Poisson pura com 12 amostras, pela aproximação qui-quadrado com 11 graus de liberdade, um índice
abaixo de 0,1 tem probabilidade da ordem de 1 em 10 mil por janela, e abaixo de 0,05, de 2 em 1 milhão. Audiência real (com ciclo diário, tendência e ruído extra) fica bem acima de 1. Janelas com tendência
inflam a variância, então o erro aqui tende a ser deixar passar, não acusar.

### 4. `rajadas_periodicas`: rajadas em intervalo fixo

Robô agendado entrega um lote a cada `k` horas, às vezes uma hora antes ou depois.

1. Linha de base local: mediana de `x` nas 12 horas antes e depois de cada hora.
2. Rajada: hora com `x >= 3 × base local` e `x - base local >= 50`. Horas de rajada coladas contam como uma.
3. Com pelo menos 4 rajadas, calcula os intervalos entre inícios consecutivos.
4. Para cada `k` de 2 a 12 horas, conta os intervalos a até 1 hora de `k`. Fica o `k` que aceita mais
   intervalos (empate: o com mais intervalos exatos).
5. Valor: fração dos intervalos aceitos por esse `k`.

Dispara se o valor é igual ou maior que o limiar calibrado. Periodicidade de 24 horas fica fora de propósito:
é o ciclo dia/noite de gente de verdade. A folga de ±1 hora pegou o robô com atraso ocasional sem custo no
ciclo dia/noite forte do dataset; o custo possível está em criador com rajadas casuais, que a calibração
mede.

### 5. `patamar_liso`: nível alto que quase não varia

O índice de dispersão compara a variância com a de uma Poisson. Em volume alto isso deixa escapar o robô que
adiciona um ruído pequeno de propósito: 3.000 views/h com 2% de variação tem variância muito maior que a média,
e passa por `repeticao_mecanica`. Mas audiência real nesse volume, por 12 horas, sobe e desce bem mais que 2%.

Para cada janela de 12 horas com média de pelo menos 200 views/h **e** pelo menos 3 vezes a mediana da série,
calcula a variação relativa (desvio padrão / média). O valor do sinal é a menor encontrada. Dispara abaixo de
4%. Este limite é fixo, fora da grade de calibração.

A exigência de destoar da mediana é o que poupa o canal grande e liso: com dezenas de milhares de views por hora
e ruído relativo de 1% a 3%, a série inteira fica no mesmo nível, nenhuma janela chega a 3 vezes a mediana e o
sinal nem é avaliado. O dataset tem essa família legítima (`canal_grande_liso`) para medir o custo.

## Como os sinais se combinam

Na ordem, a primeira regra que bate decide:

1. Série com menos de 24 horas: `inconclusivo` (a API nem chega aqui, devolve 400).
2. Algum sinal disparou: `suspeito`, com uma exceção. O motivo junta a explicação de cada sinal que disparou.
   A exceção é a queda abrupta isolada: se só `queda_abrupta` disparou e o patamar antes dela variava como
   gente (dispersão de 0,3 ou mais), o resultado é `inconclusivo`. Live que termina, post que sai do destaque
   da plataforma e viral cortado têm exatamente esse formato, e acusar com base nisso é o falso positivo caro
   do enunciado. Com outro sinal junto, ou patamar regular demais, continua `suspeito`.
3. Pico relevante na zona cinza (ver `pico_sem_cauda`) ou com cauda não observável: `inconclusivo`.
4. Volume baixo: mediana abaixo de 5 views/h **e** nenhuma hora com 100 views ou mais: `inconclusivo`. Com
   tão poucas views, ruído e padrão ficam parecidos. Esta regra só vale quando nenhum sinal disparou (regra
   2): uma conta pequena com um sinal disparado continua `suspeito`, e uma com mediana baixa mas alguma hora
   de 100 views ou mais segue para as regras seguintes.
5. Série com menos de 48 horas: `inconclusivo`. Cedo demais para afirmar que é legítima.
6. Caso contrário: `legitimo`.

Fora a queda isolada, um sinal sozinho basta para `suspeito`, porque cada limiar foi posto onde audiência
humana quase nunca chega. Isso aumenta o recall; o custo é que um falso disparo de qualquer outro sinal vira
acusação. A taxa medida no dataset está no README.

## Calibração

O dataset tem duas partições geradas com sementes diferentes: `calibracao` e `avaliacao`.

`npm run calibrate` olha **só a calibração**. Testa todas as combinações de uma grade pequena dos quatro
limiares de disparo (os candidatos estão na tabela acima) e aplica uma regra explícita: maximizar o recall com
taxa de falso positivo de no máximo 2% na calibração. Empate em recall fica com menos falsos positivos; empate
nos dois fica com a combinação mais rígida (a que acusa menos), porque falso positivo custa mais caro que
deixar passar. O resultado vai para `src/classifier/thresholds.json`, versionado. Não há dependência externa,
rede nem nada aleatório: rodar de novo dá o mesmo arquivo, e um teste confere isso.

`npm run evaluate` mede com esses limiares **só na avaliação**, que a calibração nunca viu. É esse o número do
README. A diferença entre as duas partições aparece no README e mostra o quanto a calibração se ajustou ao
próprio dado.

Os parâmetros fixos (janelas de 6, 10 e 12 horas, mínimos de volume, zona cinza) não entram na grade. Eles
definem o que é medido e foram escolhidos pelo raciocínio de cada sinal, não por busca.

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
  `repeticao_mecanica`, e um com mais de 4% de variação relativa escapa de `patamar_liso`. O mesmo vale para
  patamar artificial somado a muita audiência real, ou que não chega a 3 vezes a mediana da série.
- **Rajadas com intervalo irregular**, que variam mais de 1 hora, periódicas a cada 24 horas ou tão frequentes
  (a cada 2 horas) que viram a própria linha de base local.
- **Live curta.** Uma transmissão de 2 ou 3 horas que começa e termina de uma vez tem o mesmo formato de um
  lote comprado (degrau sem cauda) e vira `suspeito`. É a maior fonte de falso positivo no dataset. Distinguir
  exigiria saber que houve live, que não está na série.
- **Queda abrupta de patamar com ruído de gente.** Por ser o formato de live, destaque e viral cortado, sozinha
  ela dá `inconclusivo`. O robô que entrega um patamar com ruído realista e para de uma vez não é acusado.
- **Pico comprado no fim da série.** Cai em `inconclusivo` até haver horas suficientes depois.
- **Compra pequena perto do nível do momento.** Picos secundários são examinados, mas só contam se passarem de
  5 vezes o nível logo antes deles. Um lote de 8 vezes a audiência normal, entregue ainda na cauda de um viral,
  fica abaixo disso e passa.
- **Contas pequenas.** Com mediana abaixo de 5 views/h, nenhuma hora com 100 views ou mais e nenhum sinal
  disparado, o resultado é `inconclusivo` (regra 4). Criador pequeno com ruído muito alto e sem
  correlação entre horas ainda gera alguns falsos positivos: uma hora de sorte sem nada depois tem o formato
  de `pico_sem_cauda`. A queda abrupta nessas contas quase sempre fica abaixo de 5 desvios de Poisson e nem é
  avaliada.
- **Causas legítimas de queda abrupta.** Post apagado, arquivado, tornado privado ou retirado de uma
  recomendação também derruba views de uma hora para outra. O sinal descreve o formato, não a intenção;
  `suspeito` quer dizer "merece revisão humana", não "fraude comprovada".
- **Corte que coincide com a noite.** A regra de queda sazonal ignora uma queda quando o mesmo horário do dia
  anterior ou seguinte também cai. Um pacote de views que acaba bem na hora em que a audiência real vai
  dormir pode passar, e um robô que liga e desliga no mesmo horário todo dia também.
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
| legítimo, difícil | `viral_relampago` | viral que sobe e esfria em 1 a 3 horas |
| legítimo, difícil | `viral_subida_rapida` | viral que decola em menos de uma hora |
| legítimo, difícil | `criador_pequeno_ruidoso` | 3 a 40 views/h com ruído muito alto e sem correlação entre horas |
| legítimo, difícil | `ciclo_diario_forte` | ciclo dia/noite com amplitude de 0,8 a 0,95, ou noite cortada quase a zero |
| legítimo, difícil | `live_fim_seco` | live de 2 a 8 horas com 5 a 20 vezes a audiência normal, que termina de vez |
| legítimo, difícil | `destaque_plataforma` | 6 a 24 horas em destaque, com subida de 1 ou 2 horas e saída de uma vez |
| legítimo, difícil | `viral_cortado` | viral com subida gradual, cortado de uma hora para outra no decaimento |
| legítimo, difícil | `degrau_permanente` | audiência que sobe de patamar e fica (post incorporado num site grande) |
| legítimo, difícil | `serie_curta_legitima` | audiência normal, só 24 a 47 horas de série |
| suspeito | `pico_comprado` | série orgânica mais um bloco de 1 a 3 horas de 10 a 60 vezes a base |
| suspeito | `plato_mecanico` | patamar quase constante entregue por robô sobre pouca audiência real |
| suspeito | `queda_abrupta` | patamar artificial (com ruído, não constante) que some de uma hora para outra |
| suspeito | `bot_periodico` | rajadas de 1 hora a cada 3 a 8 horas |
| suspeito, difícil | `serie_curta_comprada` | pico comprado numa série de 24 a 47 horas |
| suspeito, difícil | `compra_imitando_organico` | lote comprado com a forma de um viral, sobre pouca audiência real |
| suspeito, difícil | `compra_gradual` | views compradas somadas aos poucos ao longo de dias |

Os casos difíceis existem para o número não sair bonito à toa. `compra_imitando_organico` e `compra_gradual`
estão lá sabendo que o critério não os pega: o recall mostra esse limite em vez de escondê-lo.

O ruído orgânico é Poisson com média multiplicada por um fator log-normal (superdispersão), que é como
contagem de pessoas costuma se comportar. Os parâmetros de cada cenário estão em `src/dataset/generate.ts`.

O dataset foi feito por mim, com os sinais em mente. Ele mede se o classificador faz o que este documento
diz, não se acerta em dados reais. A taxa de falso positivo dele é um limite inferior otimista.
